import { LeastRecentlyUsedMap } from "./LeastRecentlyUsedMap.ts";
import {
  InternalDataPage,
  InternalEmptylistPage,
  InternalEmptyPage,
  InternalEntryPage,
  InternalPage,
  InternalRootPage,
  PageType,
  RawInternalPage,
} from "./InternalPage.ts";
import { Page } from "./Page.ts";

const VALID_PAGE_SIZE = [8, 9, 10, 11, 12, 13, 14, 15].map((v) =>
  Math.pow(2, v)
);

const MAX_ENTRY_PAGE_TYPE = 255 - PageType.Entry;

export type PagedFileOptions = {
  pageSize?: number;
  cacheSize?: number;
  create?: boolean;
};

export class PagedFile {
  public readonly path: string;
  public readonly pageSize: number;
  public readonly cacheSize: number;

  private readonly file: Deno.File;
  private readonly cache = new LeastRecentlyUsedMap<number, InternalPage>();
  private readonly pageCache = new Map<number, Page>();

  private isClosed = false;
  private filePageCount: number; // Number of pages in the document (written on file)
  private memoryPageCount: number; // Number of pages in the document (in cache)

  constructor(
    path: string,
    {
      pageSize = 4096,
      cacheSize = Math.round((8 * 1024 * 1024) / pageSize),
      create = true,
    }: PagedFileOptions = {},
  ) {
    if (VALID_PAGE_SIZE.includes(pageSize) === false) {
      throw new Error(`Invalid pageSize.`);
    }
    this.pageSize = pageSize;
    this.cacheSize = cacheSize;
    this.path = path;
    this.file = Deno.openSync(this.path, {
      read: true,
      write: true,
      create: create,
    });
    const stat = this.file.statSync();
    const pageCount = stat.size / this.pageSize;
    if (pageCount !== Math.floor(pageCount)) {
      throw new Error("Invalid size page count is not en integer");
    }
    this.filePageCount = pageCount;
    // memory page count always include root
    this.memoryPageCount = pageCount === 0 ? 1 : pageCount;
  }

  public get closed() {
    return this.isClosed;
  }

  // file size on disk
  public get size() {
    return this.filePageCount * this.pageSize;
  }

  // file size including memory
  public get unsavedSize() {
    return this.memoryPageCount * this.pageSize;
  }

  public getRootPage(): Page {
    if (this.isClosed) {
      throw new Error(`Cannot read closed file`);
    }
    return this.getPageFromCache(0, PageType.Root);
  }

  public getPage(addr: number, expectedType: number = PageType.Entry): Page {
    if (this.isClosed) {
      throw new Error(`Cannot read closed file`);
    }
    return this.getPageFromCache(addr, this.offsetEntryPageType(expectedType));
  }

  public createPage(pageType = 0): Page {
    if (this.isClosed) {
      throw new Error(`Cannot write closed file`);
    }
    const mainPage = this.getInternalEntryPage(
      this.getEmptyPageAddr(),
      this.offsetEntryPageType(pageType),
      false,
    );
    const page = this.instantiatePage(mainPage);
    this.pageCache.set(page.addr, page);
    return page;
  }

  public deletePage(addr: number, pageType = 0) {
    if (this.isClosed) {
      throw new Error(`Cannot delete page on closed file`);
    }
    if (addr === 0) {
      return;
    }
    this.getPageFromCache(addr, this.offsetEntryPageType(pageType)).delete();
  }

  public save() {
    if (this.isClosed) {
      throw new Error(`Cannot write closed file`);
    }
    this.cache.traverseFromOldest((page) => {
      if (page.addr >= this.filePageCount) {
        this.filePageCount = page.addr + 1;
      }
      page.writeTo(this.file);
    });
    this.checkCache();
  }

  public close() {
    this.file.close();
    this.isClosed = true;
  }

  // PRIVATE

  private offsetEntryPageType(type: number): number {
    if (type < 0) {
      throw new Error(
        `Page type must be greater or equal to ${PageType.Entry}`,
      );
    }
    if (type > MAX_ENTRY_PAGE_TYPE) {
      throw new Error(`Page type cannot exceed ${MAX_ENTRY_PAGE_TYPE}`);
    }
    return PageType.Entry + type;
  }

  private deleteInternalPage(addr: number, type: number) {
    const page = this.getInternalRootOrEntry(addr, type);
    this.emptyInternalPage(page);
    this.addAddrToEmptylist(page.addr);
    this.deleteInternalDataPage(page.nextPage);
  }

  private getInternalRootOrEntry(
    addr: number,
    expectedType: number,
  ): InternalEntryPage | InternalRootPage {
    return addr === 0 ? this.getInternalRootPage() : this.getInternalEntryPage(
      addr,
      expectedType,
      true,
    );
  }

  private getPageFromCache(addr: number, expectedType: number): Page {
    const cached = this.pageCache.get(addr);
    if (cached) {
      return cached;
    }
    const mainPage = this.getInternalRootOrEntry(addr, expectedType);
    const page = this.instantiatePage(mainPage);
    this.pageCache.set(addr, page);
    return page;
  }

  private onPageClosed(addr: number) {
    this.pageCache.delete(addr);
  }

  private instantiatePage(page: InternalRootPage | InternalEntryPage): Page {
    return new Page(
      {
        getEmptyPageAddr: this.getEmptyPageAddr.bind(this),
        getInternalDataPage: this.getInternalDataPage.bind(this),
        onPageClosed: this.onPageClosed.bind(this),
        deleteInternalPage: this.deleteInternalPage.bind(this),
        deleteInternalDataPage: this.deleteInternalDataPage.bind(this),
        getInternalRootOrEntry: this.getInternalRootOrEntry.bind(this),
        checkCache: this.checkCache.bind(this),
      },
      page.addr,
      page.type,
    );
  }

  private checkCache() {
    if (this.cache.size <= this.cacheSize) {
      return;
    }
    let deleteCount = this.cache.size - this.cacheSize;
    this.cache.traverseFromOldest((page) => {
      if (page.dirty === false) {
        deleteCount--;
        this.cache.delete(page.addr);
        if (deleteCount <= 0) {
          // stop the loop
          return false;
        }
      }
    });
  }

  private getLastEmptylistPage(): InternalEmptylistPage | null {
    const root = this.getInternalRootPage();
    if (root.emptylistAddr === 0) {
      return null;
    }
    let emptylistPage = this.getInternalEmptylistPage(root.emptylistAddr, true);
    while (emptylistPage.nextPage !== 0) {
      emptylistPage = this.getInternalEmptylistPage(
        emptylistPage.nextPage,
        true,
      );
    }
    return emptylistPage;
  }

  private getEmptyPageAddr(): number {
    const emptylistPage = this.getLastEmptylistPage();
    if (emptylistPage === null) {
      // No emptylist add page at the end
      const pageAddr = this.memoryPageCount;
      this.memoryPageCount += 1;
      return pageAddr;
    }
    if (emptylistPage.empty) {
      // Empty empty list => remove next page from prev and use emptylist as new empty page
      this.emptyInternalPage(emptylistPage);
      if (emptylistPage.prevPage === 0) {
        // prev is root
        const root = this.getInternalRootPage();
        root.emptylistAddr = 0;
        return emptylistPage.addr;
      }
      // prev is another emptylist
      const prevPage = this.getInternalEmptylistPage(
        emptylistPage.prevPage,
        true,
      );
      prevPage.prevPage = 0;
      return emptylistPage.addr;
    }
    return emptylistPage.pop();
  }

  private deleteInternalDataPage(addr: number) {
    if (addr === 0) {
      return;
    }
    const page = this.getInternalDataPage(addr, true);
    this.emptyInternalPage(page);
    this.addAddrToEmptylist(page.addr);
    this.deleteInternalDataPage(page.nextPage);
  }

  private emptyInternalPage(page: InternalPage) {
    page.markDeleted();
    this.cache.set(page.addr, new InternalEmptyPage(this.pageSize, page.addr));
  }

  private addAddrToEmptylist(addr: number) {
    const emptylist = this.getLastEmptylistPage();
    if (emptylist === null) {
      // create emptylist with the empty address
      this.getInternalEmptylistPage(addr, false);
      const root = this.getInternalRootPage();
      root.emptylistAddr = addr;
      return;
    }
    if (emptylist.full) {
      // create next emptylist with the empty address
      this.getInternalEmptylistPage(addr, false);
      emptylist.nextPage = addr;
      return;
    }
    emptylist.push(addr);
  }

  // deno-fmt-ignore
  private ensureInternalPageType(page: InternalPage, type: PageType.Root): InternalRootPage;
  // deno-fmt-ignore
  private ensureInternalPageType(page: InternalPage, type: PageType.Emptylist): InternalEmptylistPage;
  // deno-fmt-ignore
  private ensureInternalPageType(page: InternalPage, type: PageType.Data): InternalDataPage;
  // deno-fmt-ignore
  private ensureInternalPageType(page: InternalPage, type: number): InternalEntryPage;
  // deno-fmt-ignore
  private ensureInternalPageType(page: InternalPage, type: PageType): InternalPage {
    if (page.type !== type) {
      throw new Error(`Page type mismatch`);
    }
    return page;
  }

  private getInternalRootPage(): InternalRootPage {
    return this.ensureInternalPageType(
      this.getInternalPage(0, PageType.Root, false),
      PageType.Root,
    );
  }

  private getInternalEntryPage(
    addr: number,
    expectedType: number,
    mustExist: boolean,
  ): InternalEntryPage {
    return this.ensureInternalPageType(
      this.getInternalPage(
        addr,
        expectedType,
        mustExist,
      ),
      expectedType,
    ) as unknown as InternalEntryPage;
  }

  private getInternalDataPage(
    addr: number,
    mustExist: boolean,
  ): InternalDataPage {
    if (addr === 0) {
      throw new Error(`Cannot get null pointer Data page`);
    }
    return this.ensureInternalPageType(
      this.getInternalPage(addr, PageType.Data, mustExist),
      PageType.Data,
    );
  }

  private getInternalEmptylistPage(
    addr: number,
    mustExist: boolean,
  ): InternalEmptylistPage {
    return this.ensureInternalPageType(
      this.getInternalPage(addr, PageType.Emptylist, mustExist),
      PageType.Emptylist,
    );
  }

  private getInternalPage(
    pageAddr: number,
    expectedType: number,
    mustExist: boolean,
  ): InternalPage {
    const cached = this.cache.get(pageAddr);
    const isEmpty = Boolean(cached && cached.type !== PageType.Empty);
    if (cached) {
      if (cached.type === PageType.Empty) {
        const buffer = new Uint8Array(this.pageSize);
        buffer[0] = expectedType;
        const page = this.instantiateInternalPage(pageAddr, buffer, true);
        this.cache.set(pageAddr, page);
        return page;
      }
      if (cached.type !== expectedType) {
        throw new Error(
          `Page type mismatch at ${pageAddr}: Expecting ${expectedType} received ${cached.type}`,
        );
      }
      return cached;
    }
    const [buffer, isNew] = this.getPageBuffer(
      pageAddr,
      expectedType,
      mustExist,
    );
    const page = this.instantiateInternalPage(
      pageAddr,
      buffer,
      isNew || isEmpty,
    );
    this.cache.set(pageAddr, page);
    return page;
  }

  private instantiateInternalPage(
    pageAddr: number,
    buffer: Uint8Array,
    isNew: boolean,
  ): InternalPage {
    const type: PageType = buffer[0];
    const basePage = new RawInternalPage(
      this.pageSize,
      pageAddr,
      buffer,
      type,
      isNew,
    );
    if (type === PageType.Empty) {
      throw new Error(`Cannot instantiate empty pagbe`);
    }
    if (type === PageType.Root) {
      return new InternalRootPage(basePage, isNew);
    }
    if (type === PageType.Emptylist) {
      return new InternalEmptylistPage(basePage);
    }
    if (type === PageType.Data) {
      return new InternalDataPage(basePage);
    }
    return new InternalEntryPage(basePage);
  }

  /**
   * Get buffer for the page, created it if outside the file size
   */
  private getPageBuffer(
    pageAddr: number,
    expectedType: number,
    mustExist: boolean,
  ): [buffer: Uint8Array, isNew: boolean] {
    const isOnFile = pageAddr < this.filePageCount;
    // sanity check
    if (pageAddr >= this.memoryPageCount) {
      throw new Error(`What ?`);
    }
    if (!isOnFile && mustExist) {
      throw new Error(`Range exceeded.`);
    }
    if (isOnFile) {
      const buffer = this.readPageBuffer(pageAddr);
      if (buffer[0] === PageType.Empty) {
        // if page is empty => change type (empty page buffer is empty so we can reuse it)
        buffer[0] = expectedType;
        return [buffer, true];
      }
      if (buffer[0] !== expectedType) {
        throw new Error(
          `Page type mismatch at addr ${pageAddr}: Expecting ${expectedType} received ${
            buffer[0]
          }`,
        );
      }
      return [buffer, false];
    }
    const buffer = new Uint8Array(this.pageSize);
    buffer[0] = expectedType;
    return [buffer, true];
  }

  private readPageBuffer(pageAddr: number): Uint8Array {
    if (pageAddr < 0) {
      throw new Error(`Invalid page address`);
    }
    const offset = this.pageSize * pageAddr;
    const buffer = new Uint8Array(this.pageSize);
    this.file.seekSync(offset, Deno.SeekMode.Start);
    for (let i = 0; i < this.pageSize;) {
      const nread = this.file.readSync(buffer.subarray(i));
      if (nread === null) {
        throw new Error("Unexpected EOF");
      }
      i += nread;
    }
    return buffer;
  }

  debug(
    { includeMemory = true }: { includeMemory?: boolean } = {},
  ): Array<string> {
    const result: Array<string> = [];
    if (this.filePageCount === 0) {
      return [];
    }
    for (let addr = 0; addr < this.filePageCount; addr++) {
      const cached = this.cache.get(addr);
      if (cached && includeMemory) {
        result.push(internalPageToString(cached));
      } else {
        const pageBuffer = this.readPageBuffer(addr);
        result.push(pageBufferToString(addr, pageBuffer, this.pageSize));
      }
    }
    return result;
  }
}

function internalPageToString(page: InternalPage): string {
  if (page.type === PageType.Empty) {
    return `${("000" + page.addr).slice(-3)}: Empty`;
  }
  if (page instanceof InternalRootPage) {
    return `${
      ("000" + page.addr).slice(-3)
    }: Root [pageSize: ${page.pageSize}, emptylistAddr: ${page.emptylistAddr}, nextPage: ${page.nextPage}]`;
  }
  if (page instanceof InternalEmptylistPage) {
    const emptyPages: Array<number> = [];
    for (let i = 0; i < page.count; i++) {
      emptyPages.push(page.readAtIndex(i));
    }
    return `${
      ("000" + page.addr).slice(-3)
    }: Emptylist [prevPage: ${page.prevPage}, count: ${page.count}, nextPage: ${page.nextPage}] Pages: ${
      emptyPages.join(", ")
    }`;
  }
  if (page instanceof InternalDataPage) {
    return `${
      ("000" + page.addr).slice(-3)
    }: Data [prevPage: ${page.prevPage}, nextPage: ${page.nextPage}]`;
  }
  if (page instanceof InternalEntryPage) {
    return `${
      ("000" + page.addr).slice(-3)
    }: Entry(${page.type}) [nextPage: ${page.nextPage}]`;
  }
  throw new Error(`Invalid page`);
}

function pageBufferToString(
  addr: number,
  buffer: Uint8Array,
  pageSize: number,
): string {
  const type = buffer[0];
  const basePage = new RawInternalPage(pageSize, addr, buffer, type, false);
  if (type === PageType.Empty) {
    return (`${("000" + addr).slice(-3)}: Empty`);
  }
  if (type === PageType.Root) {
    const page = new InternalRootPage(basePage, false);
    return internalPageToString(page);
  }
  if (type === PageType.Emptylist) {
    const page = new InternalEmptylistPage(basePage);
    return internalPageToString(page);
  }
  if (type === PageType.Data) {
    const page = new InternalDataPage(basePage);
    return internalPageToString(page);
  }
  const page = new InternalEntryPage(basePage);
  return internalPageToString(page);
}

import { LeastRecentlyUsedMap as LRUMap } from "./LeastRecentlyUsedMap.ts";
import {
  DataPageBlock,
  EmptylistPageBlock,
  EmptyPageBlock,
  EntryPageBlock,
  PageBlock,
  PageBlockType,
  RootPageBlock,
} from "./PageBlock.ts";
import {
  entryPageTypeToPageBlockType,
  Page,
  PAGE_INTERNAL_CLOSE,
  PageParentRef,
} from "./Page.ts";
import {
  IPageManager,
  PageManager,
  PageManagerParentRef,
} from "./PageManager.ts";

const VALID_PAGE_SIZE = [8, 9, 10, 11, 12, 13, 14, 15].map((v) =>
  Math.pow(2, v)
);

export const MEMORY = Symbol.for("PAGED_FILE_MEMORY");

export type PagedFileOptions = {
  pageSize?: number;
  cacheSize?: number;
  create?: boolean;
};

export class PagedFile implements IPageManager {
  public readonly path: string | typeof MEMORY;
  public readonly pageSize: number;
  public readonly cacheSize: number;

  private readonly file: Deno.File | null;
  private readonly blockCache = new LRUMap<number, PageBlock>();
  private readonly pageCache = new Map<
    number,
    { page: Page; managers: Set<PageManager> }
  >();
  private readonly mainManager: PageManager;
  private readonly pageManagerParentRef: PageManagerParentRef;
  private readonly pageParentRef: PageParentRef;

  private isClosed = false;
  private filePageCount: number; // Number of pages in the document (written on file)
  private memoryPageCount: number; // Number of pages in the document (in cache)

  constructor(
    path: string | typeof MEMORY,
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
    this.file = path === MEMORY ? null : Deno.openSync(path, {
      read: true,
      write: true,
      create: create,
    });
    const fileSize = this.file ? this.file.statSync().size : 0;
    const pageCount = fileSize / this.pageSize;
    if (pageCount !== Math.floor(pageCount)) {
      throw new Error("Invalid size page count is not en integer");
    }
    this.filePageCount = pageCount;
    // memory page count always include root
    this.memoryPageCount = pageCount === 0 ? 1 : pageCount;
    this.mainManager = this.createManager();
    this.pageManagerParentRef = {
      deletePage: this.deletePage.bind(this),
      releaseAllPagesForManager: this.releaseAllPagesForManager.bind(this),
      releasePageForManager: this.releasePageForManager.bind(this),
      createPageForManager: this.createPageForManager.bind(this),
      getOpenPagesForManager: this.getOpenPagesForManager.bind(this),
      getPageForManager: this.getPageForManager.bind(this),
      getRootPageForManager: this.getRootPageForManager.bind(this),
    };
    this.pageParentRef = {
      getEmptyPageAddr: this.getEmptyPageAddr.bind(this),
      getDataPageBlock: this.getDataPageBlock.bind(this),
      onPageClosed: this.onPageClosed.bind(this),
      deletePageBlock: this.deletePageBlock.bind(this),
      deleteDataPageBlock: this.deleteDataPageBlock.bind(this),
      getInternalRootOrEntry: this.getInternalRootOrEntry.bind(this),
      checkCache: this.checkCache.bind(this),
    };
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

  public createManager(): PageManager {
    return new PageManager(this.pageManagerParentRef);
  }

  public getRootPage(): Page {
    return this.getRootPageForManager(this.mainManager);
  }

  public getPage(addr: number, pageType: number | null = null): Page {
    return this.getPageForManager(this.mainManager, addr, pageType);
  }

  public createPage(pageType: number | null = null): Page {
    return this.createPageForManager(this.mainManager, pageType);
  }

  public deletePage(
    addr: number,
    pageType: number | null = null,
  ) {
    if (this.isClosed) {
      throw new Error(`Cannot delete page on closed file`);
    }
    if (addr === 0) {
      return;
    }
    const page = this.getPageFromCache(
      null,
      addr,
      pageType === null ? null : entryPageTypeToPageBlockType(pageType),
    );
    page.delete();
  }

  public getOpenPages(): Array<Page> {
    return this.getOpenPagesForManager(this.mainManager);
  }

  public releasePage(page: number | Page) {
    return this.releasePageForManager(this.mainManager, page);
  }

  public forceReleasePage(page: number | Page) {
    const addr = page instanceof Page ? page.addr : page;
    const cached = this.pageCache.get(addr);
    if (cached) {
      cached.managers.clear();
    }
  }

  public releaseAllPages() {
    return this.releaseAllPagesForManager(this.mainManager);
  }

  public forceReleaseAllPages() {
    for (const [_addr, { managers }] of this.pageCache) {
      managers.clear();
    }
  }

  public save() {
    if (this.isClosed) {
      throw new Error(`Cannot write closed file`);
    }
    const file = this.file;
    if (file === null) {
      throw new Error(`Cannot save MEMORY file`);
    }
    this.blockCache.traverseFromOldest((page) => {
      if (page.addr >= this.filePageCount) {
        this.filePageCount = page.addr + 1;
      }
      page.writeTo(file);
    });
    this.checkCache();
  }

  public close() {
    if (this.file) {
      this.file.close();
    }
    this.isClosed = true;
  }

  // PRIVATE

  private getRootPageForManager(manager: PageManager): Page {
    if (this.isClosed) {
      throw new Error(`Cannot read closed file`);
    }
    return this.getPageFromCache(manager, 0, PageBlockType.Root);
  }

  private getPageForManager(
    manager: PageManager,
    addr: number,
    pageType: number | null = null,
  ): Page {
    if (this.isClosed) {
      throw new Error(`Cannot read closed file`);
    }
    return this.getPageFromCache(
      manager,
      addr,
      pageType === null ? null : entryPageTypeToPageBlockType(pageType),
    );
  }

  private createPageForManager(
    manager: PageManager,
    pageType: number | null = null,
  ): Page {
    if (this.isClosed) {
      throw new Error(`Cannot write closed file`);
    }
    const mainPage = this.getEntryPageBlock(
      this.getEmptyPageAddr(),
      pageType === null ? null : entryPageTypeToPageBlockType(pageType),
      false,
    );
    const page = this.instantiatePage(mainPage);
    this.pageCache.set(page.addr, { page, managers: new Set([manager]) });
    return page;
  }

  private getOpenPagesForManager(manager: PageManager): Array<Page> {
    const pages: Array<Page> = [];
    for (const [_addr, { page, managers }] of this.pageCache) {
      if (managers.has(manager)) {
        pages.push(page);
      }
    }
    return pages;
  }

  private releasePageForManager(manager: PageManager, page: number | Page) {
    const addr = page instanceof Page ? page.addr : page;
    const cached = this.pageCache.get(addr);
    if (cached) {
      if (cached.managers.has(manager)) {
        cached.managers.delete(manager);
      }
    }
  }

  private releaseAllPagesForManager(manager: PageManager) {
    for (const [_addr, { managers }] of this.pageCache) {
      if (managers.has(manager)) {
        managers.delete(manager);
      }
    }
  }

  private deletePageBlock(addr: number, type: number) {
    const page = this.getInternalRootOrEntry(addr, type);
    this.emptyPageBlock(page);
    this.addAddrToEmptylist(page.addr);
    this.deleteDataPageBlock(page.nextPage);
  }

  private getInternalRootOrEntry(
    addr: number,
    expectedType: number | null,
  ): EntryPageBlock | RootPageBlock {
    return addr === 0 ? this.getRootPageBlock() : this.getEntryPageBlock(
      addr,
      expectedType,
      true,
    );
  }

  private getPageFromCache(
    manager: PageManager | null,
    addr: number,
    expectedType: number | null,
  ): Page {
    if (this.isClosed) {
      throw new Error(`Cannot read closed file`);
    }
    const cached = this.pageCache.get(addr);
    if (cached) {
      if (manager === null) {
        return cached.page;
      }
      if (cached.managers.has(manager) === false) {
        cached.managers.add(manager);
      }
      return cached.page;
    }
    const mainPage = this.getInternalRootOrEntry(addr, expectedType);
    const page = this.instantiatePage(mainPage);
    this.pageCache.set(addr, {
      page,
      managers: new Set(manager === null ? [] : [manager]),
    });
    return page;
  }

  private onPageClosed(addr: number) {
    this.pageCache.delete(addr);
  }

  private instantiatePage(page: RootPageBlock | EntryPageBlock): Page {
    return new Page(
      this.pageParentRef,
      page.addr,
      page.type,
    );
  }

  private checkCache() {
    this.checkBlockCache();
    this.checkPageCache();
  }

  private checkBlockCache() {
    if (this.blockCache.size <= this.cacheSize) {
      return;
    }
    let deleteCount = this.blockCache.size - this.cacheSize;
    this.blockCache.traverseFromOldest((page) => {
      if (page.dirty === false) {
        deleteCount--;
        page.close();
        this.blockCache.delete(page.addr);
        if (deleteCount <= 0) {
          // stop the loop
          return false;
        }
      }
    });
  }

  private checkPageCache() {
    for (const [addr, { managers, page }] of this.pageCache) {
      if (managers.size === 0) {
        this.pageCache.delete(addr);
        page[PAGE_INTERNAL_CLOSE]();
      }
    }
  }

  private getLastEmptylistPage(): EmptylistPageBlock | null {
    const root = this.getRootPageBlock();
    if (root.emptylistAddr === 0) {
      return null;
    }
    let emptylistPage = this.getEmptylistPageBlock(root.emptylistAddr, true);
    while (emptylistPage.nextPage !== 0) {
      emptylistPage = this.getEmptylistPageBlock(
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
      this.emptyPageBlock(emptylistPage);
      if (emptylistPage.prevPage === 0) {
        // prev is root
        const root = this.getRootPageBlock();
        root.emptylistAddr = 0;
        return emptylistPage.addr;
      }
      // prev is another emptylist
      const prevPage = this.getEmptylistPageBlock(
        emptylistPage.prevPage,
        true,
      );
      prevPage.prevPage = 0;
      return emptylistPage.addr;
    }
    return emptylistPage.pop();
  }

  private deleteDataPageBlock(addr: number) {
    if (addr === 0) {
      return;
    }
    const page = this.getDataPageBlock(addr, true);
    this.emptyPageBlock(page);
    this.addAddrToEmptylist(page.addr);
    this.deleteDataPageBlock(page.nextPage);
  }

  private emptyPageBlock(page: PageBlock) {
    page.close();
    this.blockCache.set(
      page.addr,
      new EmptyPageBlock(this.pageSize, page.addr),
    );
  }

  private addAddrToEmptylist(addr: number) {
    const emptylist = this.getLastEmptylistPage();
    if (emptylist === null) {
      // create emptylist with the empty address
      this.getEmptylistPageBlock(addr, false);
      const root = this.getRootPageBlock();
      root.emptylistAddr = addr;
      return;
    }
    if (emptylist.full) {
      // create next emptylist with the empty address
      this.getEmptylistPageBlock(addr, false);
      emptylist.nextPage = addr;
      return;
    }
    emptylist.push(addr);
  }

  // deno-fmt-ignore
  private ensurePageBlockType(page: PageBlock, type: PageBlockType.Root): RootPageBlock;
  // deno-fmt-ignore
  private ensurePageBlockType(page: PageBlock, type: PageBlockType.Emptylist): EmptylistPageBlock;
  // deno-fmt-ignore
  private ensurePageBlockType(page: PageBlock, type: PageBlockType.Data): DataPageBlock;
  // deno-fmt-ignore
  private ensurePageBlockType(page: PageBlock, type: number | null): EntryPageBlock;
  // deno-fmt-ignore
  private ensurePageBlockType(page: PageBlock, type: PageBlockType | null): PageBlock {
    this.ensureTypeMatch(page.addr, type, page.type)
    return page;
  }

  // check if type is what we expect
  private ensureTypeMatch(
    addr: number,
    expectedType: PageBlockType | null,
    actualType: number,
  ): void {
    const match = expectedType === null
      ? actualType >= PageBlockType.Entry
      : actualType === expectedType;
    if (!match) {
      throw new Error(
        `Page type mismatch at ${addr}: Expecting ${
          expectedType ?? `>= ${PageBlockType.Entry}`
        } received ${actualType}`,
      );
    }
  }

  private getRootPageBlock(): RootPageBlock {
    return this.ensurePageBlockType(
      this.getPageBlock(0, PageBlockType.Root, false),
      PageBlockType.Root,
    );
  }

  private getEntryPageBlock(
    addr: number,
    expectedType: number | null,
    mustExist: boolean,
  ): EntryPageBlock {
    return this.ensurePageBlockType(
      this.getPageBlock(
        addr,
        expectedType,
        mustExist,
      ),
      expectedType,
    ) as unknown as EntryPageBlock;
  }

  private getDataPageBlock(
    addr: number,
    mustExist: boolean,
  ): DataPageBlock {
    if (addr === 0) {
      throw new Error(`Cannot get null pointer Data page`);
    }
    return this.ensurePageBlockType(
      this.getPageBlock(addr, PageBlockType.Data, mustExist),
      PageBlockType.Data,
    );
  }

  private getEmptylistPageBlock(
    addr: number,
    mustExist: boolean,
  ): EmptylistPageBlock {
    return this.ensurePageBlockType(
      this.getPageBlock(addr, PageBlockType.Emptylist, mustExist),
      PageBlockType.Emptylist,
    );
  }

  private getPageBlock(
    pageAddr: number,
    expectedType: number | null,
    mustExist: boolean,
  ): PageBlock {
    const cached = this.blockCache.get(pageAddr);
    if (cached) {
      if (cached.type === PageBlockType.Empty) {
        const buffer = new Uint8Array(this.pageSize);
        const typeResolved = expectedType ?? PageBlockType.Entry;
        buffer[0] = typeResolved;
        const page = this.instantiatePageBlock(pageAddr, buffer, true);
        this.blockCache.set(pageAddr, page);
        return page;
      }
      this.ensureTypeMatch(pageAddr, expectedType, cached.type);
      return cached;
    }
    const [buffer, isNew] = this.getPageBuffer(
      pageAddr,
      expectedType,
      mustExist,
    );
    const page = this.instantiatePageBlock(
      pageAddr,
      buffer,
      isNew,
    );
    this.blockCache.set(pageAddr, page);
    return page;
  }

  private instantiatePageBlock(
    pageAddr: number,
    buffer: Uint8Array,
    isNew: boolean,
  ): PageBlock {
    const type: PageBlockType = buffer[0];
    if (type === PageBlockType.Empty) {
      throw new Error(`Cannot instantiate empty pagbe`);
    }
    if (type === PageBlockType.Root) {
      return new RootPageBlock(this.pageSize, buffer, isNew);
    }
    if (type === PageBlockType.Emptylist) {
      return new EmptylistPageBlock(this.pageSize, pageAddr, buffer, isNew);
    }
    if (type === PageBlockType.Data) {
      return new DataPageBlock(this.pageSize, pageAddr, buffer, isNew);
    }
    return new EntryPageBlock(this.pageSize, pageAddr, buffer, type, isNew);
  }

  /**
   * Get buffer for the page, created it if outside the file size
   */
  private getPageBuffer(
    pageAddr: number,
    expectedType: number | null,
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
      if (buffer[0] === PageBlockType.Empty) {
        // if page is empty => change type (empty page buffer is empty so we can reuse it)
        buffer[0] = expectedType ?? PageBlockType.Entry;
        return [buffer, true];
      }
      this.ensureTypeMatch(pageAddr, expectedType, buffer[0]);
      return [buffer, false];
    }
    // create new buffer
    const buffer = new Uint8Array(this.pageSize);
    buffer[0] = expectedType ?? PageBlockType.Entry;
    return [buffer, true];
  }

  private readPageBuffer(pageAddr: number): Uint8Array {
    if (pageAddr < 0) {
      throw new Error(`Invalid page address`);
    }
    if (this.file === null) {
      throw new Error(`Cannot read file in MEMOMY mode`);
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
      const cached = this.blockCache.get(addr);
      if (cached && includeMemory) {
        result.push(PageBlockToString(cached));
      } else {
        const pageBuffer = this.readPageBuffer(addr);
        result.push(pageBufferToString(addr, pageBuffer, this.pageSize));
      }
    }
    return result;
  }
}

function PageBlockToString(page: PageBlock): string {
  if (page.type === PageBlockType.Empty) {
    return `${("000" + page.addr).slice(-3)}: Empty`;
  }
  if (page instanceof RootPageBlock) {
    return `${
      ("000" + page.addr).slice(-3)
    }: Root [pageSize: ${page.pageSize}, emptylistAddr: ${page.emptylistAddr}, nextPage: ${page.nextPage}]`;
  }
  if (page instanceof EmptylistPageBlock) {
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
  if (page instanceof DataPageBlock) {
    return `${
      ("000" + page.addr).slice(-3)
    }: Data [prevPage: ${page.prevPage}, nextPage: ${page.nextPage}]`;
  }
  if (page instanceof EntryPageBlock) {
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
  // const basePage = new RawPageBlock(pageSize, addr, buffer, type, false);
  if (type === PageBlockType.Empty) {
    return (`${("000" + addr).slice(-3)}: Empty`);
  }
  if (type === PageBlockType.Root) {
    const page = new RootPageBlock(pageSize, buffer, false);
    return PageBlockToString(page);
  }
  if (type === PageBlockType.Emptylist) {
    const page = new EmptylistPageBlock(pageSize, addr, buffer, false);
    return PageBlockToString(page);
  }
  if (type === PageBlockType.Data) {
    const page = new DataPageBlock(pageSize, addr, buffer, false);
    return PageBlockToString(page);
  }
  const page = new EntryPageBlock(pageSize, addr, buffer, type, false);
  return PageBlockToString(page);
}

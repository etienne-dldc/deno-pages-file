import { LeastRecentlyUsedMap } from "./LeastRecentlyUsedMap.ts";
import {
  DataPage,
  EntryPage,
  EmptylistPage,
  Page,
  PageType,
  RootPage,
  EmptyPage,
} from "./Page.ts";
import { PageBuffer } from "./PageBuffer.ts";

const VALID_PAGE_SIZE = [8, 9, 10, 11, 12, 13, 14, 15].map((v) =>
  Math.pow(2, v)
);

export type InstantiatePage = (
  pageSize: number,
  addr: number,
  buffer: Uint8Array,
  type: number,
  isNew: boolean
) => EntryPage;

export type InstantiateRootPage = (
  pageSize: number,
  buffer: Uint8Array,
  isNew: boolean
) => RootPage;

export type PagedFileOptions = {
  pageSize?: number;
  cacheSize?: number;
  instantiatePage?: InstantiatePage;
  instantiateRootPage?: InstantiateRootPage;
};

export class PagedFile {
  public readonly path: string;
  public readonly pageSize: number;
  public readonly cacheSize: number;

  private readonly file: Deno.File;
  private readonly cache = new LeastRecentlyUsedMap<number, Page>();

  private isClosed = false;
  private filePageCount: number; // Number of pages in the document (written on file)
  private memoryPageCount: number; // Number of pages in the document (in cache)
  private instantiateEntryPage?: InstantiatePage;
  private instantiateRootPage?: InstantiateRootPage;

  constructor(
    path: string,
    {
      pageSize = 4096,
      cacheSize = Math.round((8 * 1024 * 1024) / pageSize),
      instantiatePage,
    }: PagedFileOptions = {}
  ) {
    if (VALID_PAGE_SIZE.includes(pageSize) === false) {
      throw new Error(`Invalid pageSize.`);
    }
    this.instantiateEntryPage = instantiatePage;
    this.pageSize = pageSize;
    this.cacheSize = cacheSize;
    this.path = path;
    this.file = Deno.openSync(this.path, {
      read: true,
      write: true,
      create: true,
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

  public readRootPage(): Uint8Array {
    if (this.isClosed) {
      throw new Error(`Cannot read closed file`);
    }
    const page = this.getRootPage();
    const result = this.readPageContent(page).read.copyReadonly();
    this.checkCache();
    return result;
  }

  public writeRootPage(content: Uint8Array): void {
    if (this.isClosed) {
      throw new Error(`Cannot write closed file`);
    }
    const page = this.getRootPage();
    this.writePageContent(page, content);
  }

  public readPage(
    addr: number,
    expectedType: number = PageType.Entry
  ): Uint8Array {
    if (this.isClosed) {
      throw new Error(`Cannot read closed file`);
    }
    const page = this.getEntryPage(addr, expectedType, true);
    const result = this.readPageContent(page).read.copyReadonly();
    this.checkCache();
    return result;
  }

  public writePage(
    addr: number,
    content: Uint8Array,
    expectedType: number = PageType.Entry
  ): void {
    if (this.isClosed) {
      throw new Error(`Cannot write closed file`);
    }
    const page = this.getEntryPage(addr, expectedType, true);
    this.writePageContent(page, content);
  }

  public createPage(pageType: number = PageType.Entry): number {
    if (this.isClosed) {
      throw new Error(`Cannot write closed file`);
    }
    const page = this.getEntryPage(this.getEmptyPageAddr(), pageType, false);
    return page.addr;
  }

  public deletePage(addr: number, pageType: number = PageType.Entry) {
    if (addr === 0) {
      return;
    }
    const page = this.getPage(addr, pageType, true);
    this.emptyPage(page);
    this.addAddrToEmptylist(page.addr);
    this.deleteDataPage(page.nextAddr);
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

  public get closed() {
    return this.isClosed;
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

  private writePageContent(page: RootPage | EntryPage, content: Uint8Array) {
    if (content.byteLength <= page.contentLenth) {
      page.setContent(content);
      this.deleteDataPage(page.nextAddr);
      page.nextAddr = 0;
    } else {
      page.setContent(content.subarray(0, page.contentLenth));
      const currentNextAddress = page.nextAddr;
      const nextAddr = this.writeToDataPage(
        currentNextAddress,
        page.addr,
        content.subarray(page.contentLenth)
      );
      page.nextAddr = nextAddr;
    }
  }

  private writeToDataPage(
    pageAddr: number,
    prevAddr: number,
    content: Uint8Array
  ): number {
    const resolvedPageAddr =
      pageAddr === 0 ? this.getEmptyPageAddr() : pageAddr;
    const page = this.getDataPage(resolvedPageAddr, false);
    page.prevAddr = prevAddr;
    if (content.byteLength <= page.contentLenth) {
      page.setContent(content);
      this.deleteDataPage(page.nextAddr);
      page.nextAddr = 0;
    } else {
      page.setContent(content.subarray(0, page.contentLenth));
      const nextAddr = this.writeToDataPage(
        page.nextAddr,
        page.addr,
        content.subarray(page.contentLenth)
      );
      page.nextAddr = nextAddr;
    }
    return resolvedPageAddr;
  }

  private readPageContent(page: RootPage | EntryPage): PageBuffer {
    if (page.nextAddr === 0) {
      return page.getContent();
    }
    return this.readDataPage(page.getContent(), page.nextAddr);
  }

  private readDataPage(content: PageBuffer, pageAddr: number): PageBuffer {
    const page = this.getDataPage(pageAddr, true);
    const expendedContent = content.mergeWith(page.getContent());
    if (page.nextAddr === 0) {
      return expendedContent;
    }
    return this.readDataPage(expendedContent, page.nextAddr);
  }

  private getLastEmptylistPage(): EmptylistPage | null {
    const root = this.getRootPage();
    if (root.emptylistAddr === 0) {
      return null;
    }
    let emptylistPage = this.getEmptylistPage(root.emptylistAddr, true);
    while (emptylistPage.nextAddr !== 0) {
      emptylistPage = this.getEmptylistPage(emptylistPage.nextAddr, true);
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
      this.emptyPage(emptylistPage);
      // Empty empty list => remove next page from prev and use emptylist as new empty page
      if (emptylistPage.prevAddr === 0) {
        // prev is root
        const root = this.getRootPage();
        root.emptylistAddr = 0;
        return emptylistPage.addr;
      }
      // prev is another emptylist
      const prevPage = this.getEmptylistPage(emptylistPage.prevAddr, true);
      prevPage.nextAddr = 0;
      return emptylistPage.addr;
    }
    return emptylistPage.pop();
  }

  private deleteDataPage(addr: number) {
    if (addr === 0) {
      return;
    }
    const page = this.getPage(addr, PageType.Data, true);
    this.emptyPage(page);
    this.addAddrToEmptylist(page.addr);
    this.deleteDataPage(page.nextAddr);
  }

  private emptyPage(page: Page) {
    page.markDeleted();
    this.cache.set(page.addr, new EmptyPage(this.pageSize, page.addr));
  }

  private addAddrToEmptylist(addr: number) {
    const emptylist = this.getLastEmptylistPage();
    if (emptylist === null) {
      // create emptylist with the empty address
      this.getEmptylistPage(addr, false);
      const root = this.getRootPage();
      root.emptylistAddr = addr;
      return;
    }
    if (emptylist.full) {
      // create next emptylist with the empty address
      this.getEmptylistPage(addr, false);
      emptylist.nextAddr = addr;
      return;
    }
    emptylist.push(addr);
  }

  private ensurePageType(page: Page, type: PageType.Root): RootPage;
  private ensurePageType(page: Page, type: PageType.Emptylist): EmptylistPage;
  private ensurePageType(page: Page, type: PageType.Data): DataPage;
  private ensurePageType(page: Page, type: number): EntryPage;
  private ensurePageType(page: Page, type: PageType): Page {
    if (page.type !== type) {
      throw new Error(`Page type mismatch`);
    }
    return page;
  }

  private getRootPage(): RootPage {
    return this.ensurePageType(
      this.getPage(0, PageType.Root, false),
      PageType.Root
    );
  }

  private getEntryPage(
    addr: number,
    expectedType: number,
    mustExist: boolean
  ): EntryPage {
    if (expectedType <= PageType.Data) {
      throw new Error(`Invalid page type: Must be > ${PageType.Data}`);
    }
    return this.ensurePageType(
      this.getPage(addr, expectedType, mustExist),
      expectedType
    );
  }

  private getDataPage(addr: number, mustExist: boolean): DataPage {
    return this.ensurePageType(
      this.getPage(addr, PageType.Data, mustExist),
      PageType.Data
    );
  }

  private getEmptylistPage(addr: number, mustExist: boolean): EmptylistPage {
    return this.ensurePageType(
      this.getPage(addr, PageType.Emptylist, mustExist),
      PageType.Emptylist
    );
  }

  private getPage(
    pageAddr: number,
    expectedType: number,
    mustExist: boolean
  ): Page {
    const cached = this.cache.get(pageAddr);
    const isEmpty = Boolean(cached && cached.type !== PageType.Empty);
    if (cached) {
      if (cached.type === PageType.Empty) {
        const buffer = new Uint8Array(this.pageSize);
        buffer[0] = expectedType;
        const page = this.instantiatePage(pageAddr, buffer, true);
        this.cache.set(pageAddr, page);
        return page;
      }
      if (cached.type !== expectedType) {
        throw new Error(
          `Page type mismatch at ${pageAddr}: Expecting ${expectedType} received ${cached.type}`
        );
      }
      return cached;
    }
    const [buffer, isNew] = this.getPageBuffer(
      pageAddr,
      expectedType,
      mustExist
    );
    const page = this.instantiatePage(pageAddr, buffer, isNew || isEmpty);
    this.cache.set(pageAddr, page);
    return page;
  }

  /**
   * Get buffer for the page, created it if outside the file size
   */
  private getPageBuffer(
    pageAddr: number,
    expectedType: number,
    mustExist: boolean
  ): [buffer: Uint8Array, isNew: boolean] {
    const isOnFile = pageAddr < this.filePageCount;
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
          `Page type mismatch at addr ${pageAddr}: Expecting ${expectedType} received ${buffer[0]}`
        );
      }
      return [buffer, false];
    }
    const buffer = new Uint8Array(this.pageSize);
    buffer[0] = expectedType;
    return [buffer, true];
  }

  private instantiatePage(
    pageAddr: number,
    buffer: Uint8Array,
    isNew: boolean
  ): Page {
    const type: PageType = buffer[0];
    if (type === PageType.Empty) {
      throw new Error(`Cannot instantiate empty pagbe`);
    }
    if (type === PageType.Root) {
      if (this.instantiateRootPage) {
        return this.instantiateRootPage(this.pageSize, buffer, isNew);
      }
      return new RootPage(this.pageSize, buffer, isNew);
    }
    if (type === PageType.Emptylist) {
      return new EmptylistPage(this.pageSize, pageAddr, buffer, isNew);
    }
    if (type === PageType.Data) {
      return new DataPage(this.pageSize, pageAddr, buffer, isNew);
    }
    if (this.instantiateEntryPage) {
      return this.instantiateEntryPage(
        this.pageSize,
        pageAddr,
        buffer,
        type,
        isNew
      );
    }
    return new EntryPage(this.pageSize, pageAddr, buffer, type, isNew);
  }

  private readPageBuffer(pageAddr: number): Uint8Array {
    if (pageAddr < 0) {
      throw new Error(`Invalid page address`);
    }
    const offset = this.pageSize * pageAddr;
    const buffer = new Uint8Array(this.pageSize);
    this.file.seekSync(offset, Deno.SeekMode.Start);
    for (let i = 0; i < this.pageSize; ) {
      const nread = this.file.readSync(buffer.subarray(i));
      if (nread === null) {
        throw new Error("Unexpected EOF");
      }
      i += nread;
    }
    return buffer;
  }

  protected isEmpty(addr: number) {
    const cached = this.cache.get(addr);
    if (cached) {
      return cached.type === PageType.Empty;
    }
    const buffer = this.readPageBuffer(addr);
    return buffer[0] === PageType.Empty;
  }

  protected printPage(page: Page): void {
    if (page.type === PageType.Empty) {
      console.info(`${("000" + page.addr).slice(-3)}: Empty`);
      return;
    }
    if (page instanceof RootPage) {
      console.info(
        `${("000" + page.addr).slice(-3)}: Root [pageSize: ${
          page.pageSize
        }, emptylistAddr: ${page.emptylistAddr}, nextAddr: ${page.nextAddr}]`
      );
      return;
    }
    if (page instanceof EmptylistPage) {
      console.info(
        `${("000" + page.addr).slice(-3)}: Emptylist [prevAddr: ${
          page.prevAddr
        }, count: ${page.count}, nextAddr: ${
          page.nextAddr
        }] Pages: ${page.emptyPages.join(", ")}`
      );
      return;
    }
    if (page instanceof DataPage) {
      console.info(
        `${("000" + page.addr).slice(-3)}: Data [prevAddr: ${
          page.prevAddr
        }, nextAddr: ${page.nextAddr}]`
      );
      return;
    }
    if (page instanceof EntryPage) {
      console.info(
        `${("000" + page.addr).slice(-3)}: Entry(${page.type}) [nextAddr: ${
          page.nextAddr
        }]`
      );
      return;
    }
    throw new Error(`Invalid page`);
  }

  protected printBuffer(addr: number, buffer: Uint8Array): void {
    if (buffer[0] === PageType.Empty) {
      console.info(`${("000" + addr).slice(-3)}: Empty`);
      return;
    }
    if (buffer[0] === PageType.Root) {
      const page = new RootPage(this.pageSize, buffer, false);
      this.printPage(page);
      return;
    }
    if (buffer[0] === PageType.Emptylist) {
      const page = new EmptylistPage(this.pageSize, addr, buffer, false);
      this.printPage(page);
      return;
    }
    if (buffer[0] === PageType.Data) {
      const page = new DataPage(this.pageSize, addr, buffer, false);
      this.printPage(page);
      return;
    }
    const page = new EntryPage(this.pageSize, addr, buffer, buffer[0], false);
    this.printPage(page);
    return;
  }

  debug({ includeMemory = true }: { includeMemory?: boolean } = {}) {
    console.info("=======");
    if (this.filePageCount === 0) {
      console.info(" <Empty File>");
      return;
    }
    for (let addr = 0; addr < this.filePageCount; addr++) {
      const cached = this.cache.get(addr);
      if (cached && includeMemory) {
        this.printPage(cached);
      } else {
        const pageBuffer = this.readPageBuffer(addr);
        this.printBuffer(addr, pageBuffer);
      }
    }
  }
}

import { LeastRecentlyUsedMap } from "./LeastRecentlyUsedMap.ts";
import {
  InternalDataPage,
  InternalEmptylistPage,
  InternalEmptyPage,
  InternalEntryPage,
  InternalPageAny,
  InternalRootPage,
  PageType,
} from "./InternalPage.ts";

const VALID_PAGE_SIZE = [8, 9, 10, 11, 12, 13, 14, 15].map((v) =>
  Math.pow(2, v)
);

export type InstantiatePage = (
  pageSize: number,
  addr: number,
  buffer: Uint8Array,
  type: number,
  isNew: boolean,
) => InternalEntryPage;

export type InstantiateRootPage = (
  pageSize: number,
  buffer: Uint8Array,
  isNew: boolean,
) => InternalRootPage;

export type PagedFileOptions = {
  pageSize?: number;
  cacheSize?: number;
  create?: boolean;
  // instantiateRootPage?: InstantiateRootPage;
};

export class PagedFile {
  public readonly path: string;
  public readonly pageSize: number;
  public readonly cacheSize: number;

  private readonly file: Deno.File;
  private readonly cache = new LeastRecentlyUsedMap<number, InternalPageAny>();

  private isClosed = false;
  private filePageCount: number; // Number of pages in the document (written on file)
  private memoryPageCount: number; // Number of pages in the document (in cache)
  // private instantiateEntryPage?: InstantiatePage;
  // private instantiateRootPage?: InstantiateRootPage;

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

  public readRootPage(start?: number, length?: number): Uint8Array {
    if (this.isClosed) {
      throw new Error(`Cannot read closed file`);
    }
    const page = this.getInternalRootPage();
    const result = this.readLinkedPageContent(page, start, length);
    this.checkCache();
    return result;
  }

  public writeRootPage(content: Uint8Array, start?: number): void {
    if (this.isClosed) {
      throw new Error(`Cannot write closed file`);
    }
    const page = this.getInternalRootPage();
    this.writeLinkedPageContent(page, content, start);
  }

  public readPage(
    addr: number,
    expectedType: number = PageType.Entry,
    start?: number,
    length?: number,
  ): Uint8Array {
    if (this.isClosed) {
      throw new Error(`Cannot read closed file`);
    }
    const page = this.getInternalEntryPage(addr, expectedType, true);
    const result = this.readLinkedPageContent(page, start, length);
    this.checkCache();
    return result;
  }

  public writePage(
    addr: number,
    content: Uint8Array,
    expectedType: number = PageType.Entry,
    start?: number,
  ): void {
    if (this.isClosed) {
      throw new Error(`Cannot write closed file`);
    }
    const page = this.getInternalEntryPage(addr, expectedType, true);
    this.writeLinkedPageContent(page, content, start);
  }

  public createPage(pageType: number = PageType.Entry): number {
    if (this.isClosed) {
      throw new Error(`Cannot write closed file`);
    }
    const page = this.getInternalEntryPage(
      this.getEmptyPageAddr(),
      pageType,
      false,
    );
    return page.addr;
  }

  public deletePage(addr: number, pageType: number = PageType.Entry) {
    if (addr === 0) {
      return;
    }
    const page = this.getInternalEntryPage(addr, pageType, true);
    this.emptyPage(page);
    this.addAddrToEmptylist(page.addr);
    this.deleteDataPage(page.nextPage);
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

  private writeLinkedPageContent(
    page: InternalRootPage | InternalEntryPage,
    content: Uint8Array,
    start?: number,
    clearAfter?: boolean,
  ) {
    const startOffset = start ?? 0;
    return this.writeLinkedPageContentInternal(page, {
      type: "offset",
      offset: startOffset,
      content,
    }, clearAfter ?? false);
  }

  private writeLinkedPageContentInternal(
    page: InternalRootPage | InternalEntryPage | InternalDataPage,
    current: { type: "offset"; offset: number; content: Uint8Array } | {
      type: "write";
      content: Uint8Array;
    },
    clearAfter: boolean,
  ): void {
    const pageLength = page.contentLength;
    if (current.type === "offset") {
      if (current.offset >= pageLength) {
        // skip current page
        const nextPage = this.writeLinkedPageContentInternalByAddr(
          page.nextPage,
          {
            type: "offset",
            offset: current.offset - pageLength,
            content: current.content,
          },
          clearAfter,
        );
        page.nextPage = nextPage;
        return;
      }
      // write current page
      const startOffset = current.offset;
      const endOffset = startOffset + current.content.byteLength;
      if (endOffset <= pageLength) {
        // everything is in page
        page.writeContent(current.content, startOffset);
        if (clearAfter) {
          this.deleteDataPage(page.nextPage);
        }
        return;
      }
      // write multiple pages
      page.writeContent(current.content.subarray(0, pageLength));
      const nextPage = this.writeLinkedPageContentInternalByAddr(
        page.nextPage,
        {
          type: "write",
          content: current.content.subarray(pageLength),
        },
        clearAfter,
      );
      page.nextPage = nextPage;
      return;
    }
    // writing
    if (current.content.byteLength <= pageLength) {
      page.writeContent(current.content);
      if (clearAfter) {
        this.deleteDataPage(page.nextPage);
      }
      return;
    }
    // write multiple pages
    page.writeContent(current.content.subarray(0, pageLength));
    const nextPage = this.writeLinkedPageContentInternalByAddr(page.nextPage, {
      type: "write",
      content: current.content.subarray(pageLength),
    }, clearAfter);
    page.nextPage = nextPage;
    return;
  }

  private writeLinkedPageContentInternalByAddr(
    pageAddr: number,
    current: { type: "offset"; offset: number; content: Uint8Array } | {
      type: "write";
      content: Uint8Array;
    },
    clearAfter: boolean,
  ): number {
    if (pageAddr === 0) {
      return this.writeLinkedPageContentInternalByAddr(
        this.getEmptyPageAddr(),
        current,
        clearAfter,
      );
    }
    const page = this.getInternalDataPage(pageAddr, false);
    this.writeLinkedPageContentInternal(page, current, clearAfter);
    return page.addr;
  }

  private writeToDataPage(
    pageAddr: number,
    prevAddr: number,
    content: Uint8Array,
  ): number {
    const resolvedPageAddr = pageAddr === 0
      ? this.getEmptyPageAddr()
      : pageAddr;
    const page = this.getInternalDataPage(resolvedPageAddr, false);
    page.prevPage = prevAddr;
    if (content.byteLength <= page.contentLength) {
      page.writeContent(content);
      this.deleteDataPage(page.nextPage);
      page.nextPage = 0;
    } else {
      page.writeContent(content.subarray(0, page.contentLength));
      const nextAddr = this.writeToDataPage(
        page.nextPage,
        page.addr,
        content.subarray(page.contentLength),
      );
      page.nextPage = nextAddr;
    }
    return resolvedPageAddr;
  }

  private readLinkedPageContent(
    page: InternalRootPage | InternalEntryPage,
    start?: number,
    length?: number,
  ): Uint8Array {
    const startOffset = start ?? 0;
    return this.readLinkedPageContentInternal(page, {
      type: "offset",
      offset: startOffset,
    }, length);
  }

  private readLinkedPageContentInternal(
    page: InternalRootPage | InternalEntryPage | InternalDataPage,
    current: { type: "offset"; offset: number } | {
      type: "read";
      content: Uint8Array;
    },
    length?: number,
  ): Uint8Array {
    const pageLength = page.contentLength;
    if (current.type === "offset") {
      if (current.offset >= pageLength) {
        // skip current page
        return this.readLinkedPageContentInternalByAddr(page.nextPage, {
          type: "offset",
          offset: current.offset - pageLength,
        }, length);
      }
      // read current page
      const startOffset = current.offset;
      if (length === undefined) {
        // read full page
        const pageContent = page.readContent(startOffset);
        if (page.nextPage === 0) {
          // we are done
          return pageContent;
        }
        // read next page
        return this.readLinkedPageContentInternalByAddr(page.nextPage, {
          type: "read",
          content: pageContent,
        }, length);
      }
      const endOffset = startOffset + length;
      if (endOffset <= pageLength) {
        // everything is in page
        return page.readContent(startOffset, endOffset);
      }
      // must read multiple pages
      if (page.nextPage === 0) {
        throw new Error(`Out of range read`);
      }
      const pageContent = page.readContent(startOffset);
      return this.readLinkedPageContentInternalByAddr(page.nextPage, {
        type: "read",
        content: pageContent,
      }, length);
    }
    // reading
    if (length === undefined) {
      // no length read everything
      const content = this.mergeBuffers(current.content, page.readContent());
      if (page.nextPage === 0) {
        // we are done
        return content;
      }
      // read next page
      return this.readLinkedPageContentInternalByAddr(page.nextPage, {
        type: "read",
        content,
      }, length);
    }
    const rest = length - current.content.byteLength;
    if (rest <= pageLength) {
      return this.mergeBuffers(current.content, page.readContent(0, rest));
    }
    if (page.nextPage === 0) {
      throw new Error(`Out of range read`);
    }
    const content = this.mergeBuffers(current.content, page.readContent());
    return this.readLinkedPageContentInternalByAddr(page.nextPage, {
      type: "read",
      content,
    }, length);
  }

  private readLinkedPageContentInternalByAddr(
    pageAddr: number,
    current: { type: "offset"; offset: number } | {
      type: "read";
      content: Uint8Array;
    },
    length?: number,
  ): Uint8Array {
    if (pageAddr === 0) {
      throw new Error(`Out of range read`);
    }
    const page = this.getInternalDataPage(pageAddr, true);
    return this.readLinkedPageContentInternal(page, current, length);
  }

  private mergeBuffers(left: Uint8Array, right: Uint8Array): Uint8Array {
    const size = left.byteLength + right.byteLength;
    const resultArr = new Uint8Array(size);
    resultArr.set(left);
    resultArr.set(right, left.byteLength);
    return resultArr;
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
      this.emptyPage(emptylistPage);
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

  private deleteDataPage(addr: number) {
    if (addr === 0) {
      return;
    }
    const page = this.getInternalDataPage(addr, true);
    this.emptyPage(page);
    this.addAddrToEmptylist(page.addr);
    this.deleteDataPage(page.nextPage);
  }

  private emptyPage(page: InternalPageAny) {
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

  private ensureInternalPageType(
    page: InternalPageAny,
    type: PageType.Root,
  ): InternalRootPage;
  private ensureInternalPageType(
    page: InternalPageAny,
    type: PageType.Emptylist,
  ): InternalEmptylistPage;
  private ensureInternalPageType(
    page: InternalPageAny,
    type: PageType.Data,
  ): InternalDataPage;
  private ensureInternalPageType(
    page: InternalPageAny,
    type: number,
  ): InternalEntryPage;
  private ensureInternalPageType(
    page: InternalPageAny,
    type: PageType,
  ): InternalPageAny {
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
    if (expectedType <= PageType.Data) {
      throw new Error(`Invalid page type: Must be > ${PageType.Data}`);
    }
    return this.ensureInternalPageType(
      this.getInternalPage(addr, expectedType, mustExist),
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
  ): InternalPageAny {
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
    const page = this.instantiatePage(pageAddr, buffer, isNew || isEmpty);
    this.cache.set(pageAddr, page);
    return page;
  }

  private instantiatePage(
    pageAddr: number,
    buffer: Uint8Array,
    isNew: boolean,
  ): InternalPageAny {
    const type: PageType = buffer[0];
    if (type === PageType.Empty) {
      throw new Error(`Cannot instantiate empty pagbe`);
    }
    if (type === PageType.Root) {
      return new InternalRootPage(this.pageSize, buffer, isNew);
    }
    if (type === PageType.Emptylist) {
      return new InternalEmptylistPage(this.pageSize, pageAddr, buffer, isNew);
    }
    if (type === PageType.Data) {
      return new InternalDataPage(this.pageSize, pageAddr, buffer, isNew);
    }
    return new InternalEntryPage(this.pageSize, pageAddr, buffer, type, isNew);
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

function internalPageToString(page: InternalPageAny): string {
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
  if (buffer[0] === PageType.Empty) {
    return (`${("000" + addr).slice(-3)}: Empty`);
  }
  if (buffer[0] === PageType.Root) {
    const page = new InternalRootPage(pageSize, buffer, false);
    return internalPageToString(page);
  }
  if (buffer[0] === PageType.Emptylist) {
    const page = new InternalEmptylistPage(
      pageSize,
      addr,
      buffer,
      false,
    );
    return internalPageToString(page);
  }
  if (buffer[0] === PageType.Data) {
    const page = new InternalDataPage(pageSize, addr, buffer, false);
    return internalPageToString(page);
  }
  const page = new InternalEntryPage(
    pageSize,
    addr,
    buffer,
    buffer[0],
    false,
  );
  return internalPageToString(page);
}

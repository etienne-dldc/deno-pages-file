import { DataPageBlock, EntryPageBlock, RootPageBlock } from "./PageBlock.ts";
import { PagedFile } from "./PagedFile.ts";
import {
  BUFFER_FACADE_UNSAFE_ACCESS,
  IBufferFacade,
  IWriteValue,
  PagedBufferFacade,
} from "./buffer/mod.ts";
import { PageBlockType } from "./PageBlock.ts";

export type PageParentRef = {
  getDataPageBlock: PagedFile["getDataPageBlock"];
  getEmptyPageAddr: PagedFile["getEmptyPageAddr"];
  onPageClosed: PagedFile["onPageClosed"];
  deletePageBlock: PagedFile["deletePageBlock"];
  deleteDataPageBlock: PagedFile["deleteDataPageBlock"];
  checkCache: PagedFile["checkCache"];
  getInternalRootOrEntry: PagedFile["getInternalRootOrEntry"];
};

export const PAGE_INTERNAL_CLOSE = Symbol("PAGE_INTERNAL_CLOSE");

type PageInfo = null | DataPageBlock | RootPageBlock | EntryPageBlock;

export class Page implements IBufferFacade {
  public readonly addr: number;

  private pageBlockType: number;
  private isClosed = false;

  private readonly parent: PageParentRef;
  private readonly contentFacade: PagedBufferFacade<PageInfo>;
  private readonly pageBlockCache = new Map<
    number | null,
    DataPageBlock | RootPageBlock | EntryPageBlock
  >();

  constructor(
    parent: PageParentRef,
    addr: number,
    type: number,
  ) {
    this.parent = parent;
    this.addr = addr;
    this.pageBlockType = type;
    this.contentFacade = new PagedBufferFacade<PageInfo>(
      null,
      // getNextPage
      (prevPage, mode) => {
        if (prevPage === null) {
          const mainPage = this.getPage(null, true);
          return { buffer: mainPage.contentFacade, nextPageInfo: mainPage };
        }
        const addr = prevPage.nextPage;
        if (addr !== 0) {
          const page = this.getPage(addr, true);
          return { buffer: page.contentFacade, nextPageInfo: page };
        }
        // addr is 0 meaning prev page does not have nextPage
        if (mode === "write") {
          // create new page
          const newPageAddr = parent.getEmptyPageAddr();
          const page = this.getPage(newPageAddr, false);
          prevPage.nextPage = newPageAddr;
          return { buffer: page.contentFacade, nextPageInfo: page };
        }
        // trying to read page 0 => there are no more pages
        return null;
      },
      // deleteNextPage
      (prevPage) => {
        if (prevPage === null) {
          return;
        }
        parent.deleteDataPageBlock(prevPage.nextPage);
      },
    );
  }

  // root page return 0
  public get type(): number {
    return this.isRoot ? 0 : pageBlockTypeToEntryPageType(this.pageBlockType);
  }

  public set type(newType: number) {
    if (this.isRoot) {
      throw new Error(`Cannot change root type`);
    }
    const internalPage = this.parent.getInternalRootOrEntry(
      this.addr,
      this.pageBlockType,
    );
    if (internalPage instanceof RootPageBlock) {
      throw new Error(`Cannot change root type`);
    }
    const fixedType = entryPageTypeToPageBlockType(newType);
    internalPage.type = fixedType;
    this.pageBlockType = fixedType;
  }

  public get isRoot() {
    return this.addr === 0;
  }

  public get closed() {
    return this.isClosed;
  }

  public get byteLength(): number {
    return this.contentFacade.byteLength;
  }

  public [BUFFER_FACADE_UNSAFE_ACCESS] = (
    start = 0,
    length?: number,
  ): Uint8Array => {
    if (this.isClosed) {
      throw new Error(`Cannot read closed page`);
    }
    return this.contentFacade[BUFFER_FACADE_UNSAFE_ACCESS](start, length);
  };

  // User is not allowed to close a page because other manager might be using it too
  public [PAGE_INTERNAL_CLOSE] = () => {
    this.close();
  };

  public read(start?: number, length?: number): Uint8Array {
    if (this.isClosed) {
      throw new Error(`Cannot read closed page`);
    }
    const result = this.contentFacade.read(start, length);
    this.parent.checkCache();
    return result;
  }

  public readByte(index: number): number {
    if (this.isClosed) {
      throw new Error(`Cannot read closed page`);
    }
    const result = this.contentFacade.readByte(index);
    this.parent.checkCache();
    return result;
  }

  public write(content: IWriteValue, offset?: number): this {
    if (this.isClosed) {
      throw new Error(`Cannot write closed page`);
    }
    this.contentFacade.write(content, offset);
    this.parent.checkCache();
    return this;
  }

  // Write and delele all pages after last written page
  public writeAndCleanup(content: IWriteValue, offset = 0): this {
    if (this.isClosed) {
      throw new Error(`Cannot write closed page`);
    }
    this.contentFacade.writeAndCleanup(content, offset);
    this.parent.checkCache();
    return this;
  }

  // delete pages after offset
  public cleanupAfter(offset: number): this {
    if (this.isClosed) {
      throw new Error(`Cannot write closed page`);
    }
    this.contentFacade.cleanupAfter(offset);
    this.parent.checkCache();
    return this;
  }

  public writeByte(index: number, val: number): this {
    if (this.isClosed) {
      throw new Error(`Cannot write closed page`);
    }
    this.contentFacade.writeByte(index, val);
    this.parent.checkCache();
    return this;
  }

  public select(start?: number, length?: number): IBufferFacade {
    if (this.isClosed) {
      throw new Error(`Cannot select closed page`);
    }
    const result = this.contentFacade.select(start, length);
    this.parent.checkCache();
    return result;
  }

  public delete() {
    if (this.isRoot) {
      throw new Error(`Can't delete Root page`);
    }
    this.parent.deletePageBlock(this.addr, this.pageBlockType);
    this.close();
  }

  private close() {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.parent.onPageClosed(this.addr);
  }

  private getPage(
    addr: number | null,
    mustExists: boolean,
  ): DataPageBlock | RootPageBlock | EntryPageBlock {
    const cached = this.pageBlockCache.get(addr);
    if (cached && cached.closed === false) {
      return cached;
    }
    if (addr === null) {
      const internalPage = this.parent.getInternalRootOrEntry(
        this.addr,
        this.pageBlockType,
      );
      this.pageBlockCache.set(addr, internalPage);
      return internalPage;
    }
    const internalPage = this.parent.getDataPageBlock(addr, mustExists);
    this.pageBlockCache.set(addr, internalPage);
    return internalPage;
  }
}

const MAX_ENTRY_PAGE_TYPE = 255 - PageBlockType.Entry;

export function entryPageTypeToPageBlockType(type: number): number {
  if (type < 0) {
    throw new Error(
      `Page type must be greater or equal to ${PageBlockType.Entry}`,
    );
  }
  if (type > MAX_ENTRY_PAGE_TYPE) {
    throw new Error(`Page type cannot exceed ${MAX_ENTRY_PAGE_TYPE}`);
  }
  return PageBlockType.Entry + type;
}

export function pageBlockTypeToEntryPageType(type: number): number {
  return type - PageBlockType.Entry;
}

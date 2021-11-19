import {
  InternalDataPage,
  InternalEntryPage,
  InternalRootPage,
} from "./InternalPage.ts";
import { PagedFile } from "./PagedFile.ts";
import {
  BUFFER_FACADE_UNSAFE_ACCESS,
  IBufferFacade,
  IWriteValue,
  PagedBufferFacade,
} from "./buffer/mod.ts";
import { PageType } from "./InternalPage.ts";

export type ParentRef = {
  getInternalDataPage: PagedFile["getInternalDataPage"];
  getEmptyPageAddr: PagedFile["getEmptyPageAddr"];
  onPageClosed: PagedFile["onPageClosed"];
  deleteInternalPage: PagedFile["deleteInternalPage"];
  deleteInternalDataPage: PagedFile["deleteInternalDataPage"];
  checkCache: PagedFile["checkCache"];
  getInternalRootOrEntry: PagedFile["getInternalRootOrEntry"];
};

type PageInfo = null | InternalDataPage | InternalRootPage | InternalEntryPage;

export class Page implements IBufferFacade {
  public readonly addr: number;

  private readonly parent: ParentRef;
  private readonly internalType: number;
  private readonly contentFacade: PagedBufferFacade<PageInfo>;
  private readonly internalPageCache = new Map<
    number | null,
    InternalDataPage | InternalRootPage | InternalEntryPage
  >();

  private isClosed = false;

  constructor(
    parent: ParentRef,
    addr: number,
    type: number,
  ) {
    this.parent = parent;
    this.addr = addr;
    this.internalType = type;
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
        parent.deleteInternalDataPage(prevPage.nextPage);
      },
    );
  }

  // root page return 0
  public get type(): number {
    return this.isRoot ? 0 : this.internalType - PageType.Entry;
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

  public close() {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.parent.onPageClosed(this.addr);
  }

  public delete() {
    if (this.isRoot) {
      throw new Error(`Can't delete Root page`);
    }
    this.parent.deleteInternalPage(this.addr, this.internalType);
    this.close();
  }

  private getPage(
    addr: number | null,
    mustExists: boolean,
  ): InternalDataPage | InternalRootPage | InternalEntryPage {
    const cached = this.internalPageCache.get(addr);
    if (cached && cached.closed === false) {
      return cached;
    }
    if (addr === null) {
      const internalPage = this.parent.getInternalRootOrEntry(
        this.addr,
        this.internalType,
      );
      this.internalPageCache.set(addr, internalPage);
      return internalPage;
    }
    const internalPage = this.parent.getInternalDataPage(addr, mustExists);
    this.internalPageCache.set(addr, internalPage);
    return internalPage;
  }
}

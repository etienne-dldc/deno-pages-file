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
};

type PageInfo = null | InternalDataPage | InternalRootPage | InternalEntryPage;

export class Page implements IBufferFacade {
  private readonly parent: ParentRef;
  private readonly mainPage: InternalRootPage | InternalEntryPage;
  private readonly contentFacade: PagedBufferFacade<PageInfo>;

  private isClosed = false;

  constructor(
    parent: ParentRef,
    mainPage: InternalRootPage | InternalEntryPage,
  ) {
    this.parent = parent;
    this.mainPage = mainPage;
    this.contentFacade = new PagedBufferFacade<PageInfo>(null, // getNextPage
    (prevPage, mode) => {
      if (prevPage === null) {
        return { buffer: mainPage.contentFacade, nextPageInfo: mainPage };
      }
      const addr = prevPage.nextPage;
      if (addr !== 0) {
        const page = parent.getInternalDataPage(addr, true);
        return { buffer: page.contentFacade, nextPageInfo: page };
      }
      // addr is 0 meaning prev page does not have nextPage
      if (mode === "write") {
        // create new page
        const newPageAddr = parent.getEmptyPageAddr();
        const page = parent.getInternalDataPage(newPageAddr, false);
        prevPage.nextPage = newPageAddr;
        return { buffer: page.contentFacade, nextPageInfo: page };
      }
      // trying to read page 0 => there are no more pages
      return null;
    }, // deleteNextPage
    (prevPage) => {
      if (prevPage === null) {
        return;
      }
      parent.deleteInternalDataPage(prevPage.nextPage);
    });
  }

  public get addr() {
    return this.mainPage.addr;
  }

  // root page return 0
  public get type(): number {
    return this.isRoot ? 0 : this.mainPage.type - PageType.Entry;
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
    this.parent.deleteInternalPage(this.mainPage);
    this.close();
  }
}

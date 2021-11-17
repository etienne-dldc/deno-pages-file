import { InternalEntryPage, InternalRootPage } from "./InternalPage.ts";
import { PagedFile } from "./PagedFile.ts";

export type ParentRef = {
  readLinkedPageContent: PagedFile["readLinkedPageContent"];
  writeLinkedPageContent: PagedFile["writeLinkedPageContent"];
  onPageClosed: PagedFile["onPageClosed"];
  checkCache: PagedFile["checkCache"];
  deleteInternalPage: PagedFile["deleteInternalPage"];
};

export class Page {
  private readonly parent: ParentRef;
  private readonly mainPage: InternalRootPage | InternalEntryPage;

  private isClosed = false;

  constructor(
    parent: ParentRef,
    mainPage: InternalRootPage | InternalEntryPage,
  ) {
    this.parent = parent;
    this.mainPage = mainPage;
  }

  public get addr() {
    return this.mainPage.addr;
  }

  public get type() {
    return this.mainPage.type;
  }

  public get isRoot() {
    return this.addr === 0;
  }

  public get closed() {
    return this.isClosed;
  }

  public read(start?: number, length?: number): Uint8Array {
    if (this.isClosed) {
      throw new Error(`Cannot read closed page`);
    }
    const result = this.parent.readLinkedPageContent(
      this.mainPage,
      start,
      length,
    );
    this.parent.checkCache();
    return result;
  }

  public write(content: Uint8Array, start?: number): void {
    if (this.isClosed) {
      throw new Error(`Cannot write closed page`);
    }
    this.parent.writeLinkedPageContent(this.mainPage, content, start);
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

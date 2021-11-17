import { InternalEntryPage, InternalRootPage } from "./InternalPage.ts";
import { PagedFile } from "./PagedFile.ts";

export type ParentRef = {
  readLinkedPageContent: PagedFile["readLinkedPageContent"];
};

export class Page {
  private readonly parent: ParentRef;
  private readonly mainPage: InternalRootPage | InternalEntryPage;

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

  public read() {
    return this.parent.readLinkedPageContent(this.mainPage);
  }
}

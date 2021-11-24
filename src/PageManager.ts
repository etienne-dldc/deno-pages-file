import { Page } from "./Page.ts";
import type { PagedFile } from "./PagedFile.ts";

export interface IPageManager {
  getRootPage(): Page;
  getPage(addr: number, pageType?: number | null): Page;
  createPage(pageType?: number | null): Page;
  deletePage(addr: number, pageType?: number | null): void;
  getOpenPages(): Array<Page>;
  releaseAllPages(): void;
  releasePage(page: number | Page): void;
}

export type PageManagerParentRef = {
  deletePage: PagedFile["deletePage"];
  getRootPageForManager: PagedFile["getRootPageForManager"];
  getPageForManager: PagedFile["getPageForManager"];
  createPageForManager: PagedFile["createPageForManager"];
  getOpenPagesForManager: PagedFile["getOpenPagesForManager"];
  releaseAllPagesForManager: PagedFile["releaseAllPagesForManager"];
  releasePageForManager: PagedFile["releasePageForManager"];
};

export class PageManager implements IPageManager {
  private readonly parent: PageManagerParentRef;

  constructor(parent: PageManagerParentRef) {
    this.parent = parent;
  }

  public getRootPage(): Page {
    return this.parent.getRootPageForManager(this);
  }

  public getPage(addr: number, pageType: number | null = null): Page {
    return this.parent.getPageForManager(this, addr, pageType);
  }

  public createPage(pageType: number | null = null): Page {
    return this.parent.createPageForManager(this, pageType);
  }

  public deletePage(addr: number, pageType: number | null = null) {
    return this.parent.deletePage(addr, pageType);
  }

  public getOpenPages(): Array<Page> {
    return this.parent.getOpenPagesForManager(this);
  }

  public releasePage(page: number | Page) {
    return this.parent.releasePageForManager(this, page);
  }

  public releaseAllPages() {
    return this.parent.releaseAllPagesForManager(this);
  }
}

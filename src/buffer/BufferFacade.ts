import { DirtyManager } from "./DirtyManager.ts";

export const UNSAFE_ACCESS = Symbol.for(
  "BUFFER_FACADE_UNSAFE_ACCESS",
);

export type IWriteValue = Uint8Array | IBufferFacade;

export type IPagedBufferFacadePage<PageInfo> = {
  buffer: IBufferFacade;
  nextPageInfo: PageInfo;
};

export type IGetNextPage<PageInfo> = (
  info: PageInfo,
  reason: "read" | "write",
) => null | IPagedBufferFacadePage<PageInfo>;

export type IDeleteNextPage<PageInfo> = (lastPageInfo: PageInfo) => void;

export type IOnGuard = (reason: "read" | "write" | "select") => void;

export interface IBufferFacade {
  readonly byteLength: number;
  // get underlying buffer or a copy
  readonly [UNSAFE_ACCESS]: (start?: number, length?: number) => Uint8Array;
  // always get a copy (can't mutate)
  readonly read: (start?: number, length?: number) => Uint8Array;
  readonly readByte: (index: number) => number;
  readonly write: (content: IWriteValue, offset?: number) => this;
  readonly writeByte: (index: number, val: number) => this;
  readonly select: (start?: number, length?: number) => IBufferFacade;
}

export class SimpleBufferFacade implements IBufferFacade {
  public readonly byteLength: number;
  private readonly buffer: Uint8Array;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
    this.byteLength = buffer.byteLength;
  }

  public [UNSAFE_ACCESS] = (start = 0, length?: number): Uint8Array => {
    this.validateSelectParams(start, length);
    const end = length === undefined ? undefined : start + length;
    return this.buffer.subarray(start, end);
  };

  public read(start = 0, length?: number): Uint8Array {
    return this[UNSAFE_ACCESS](start, length).slice();
  }

  public readByte(index: number): number {
    this.validateSelectParams(index);
    return this.buffer[index];
  }

  public write(content: Uint8Array | IBufferFacade, offset = 0) {
    this.validateSelectParams(offset, content.byteLength);
    const rawContent = content instanceof Uint8Array
      ? content
      : content[UNSAFE_ACCESS]();
    this.buffer.set(rawContent, offset);
    return this;
  }

  public writeByte(index: number, val: number) {
    if (index >= this.buffer.byteLength) {
      throw new Error(`Out of range write`);
    }
    this.buffer[index] = val;
    return this;
  }

  public select(start = 0, length?: number): IBufferFacade {
    this.validateSelectParams(start, length);
    return new SelectBufferFacade(this, start, length);
  }

  private validateSelectParams(
    start: number,
    length?: number,
  ) {
    if (start < 0) {
      throw new Error(`Out of range`);
    }
    if (length !== undefined && length < 0) {
      throw new Error(`Invalid length`);
    }
    if (length === undefined) {
      return;
    }
    const end = start + length;
    if (end > this.byteLength) {
      throw new Error(
        `Out of range: end (${end}) > length (${this.byteLength})`,
      );
    }
  }
}

export class SelectBufferFacade implements IBufferFacade {
  private readonly facade: IBufferFacade;
  private readonly start: number;
  private readonly length: number | undefined;

  constructor(facade: IBufferFacade, start = 0, length?: number) {
    this.facade = facade;
    this.start = start;
    this.length = length;
  }

  public get byteLength() {
    return this.length ?? this.facade.byteLength - this.start;
  }

  public [UNSAFE_ACCESS] = (start = 0, length?: number): Uint8Array => {
    const fixedLength = this.validateSelectParams(start, length);
    return this.facade[UNSAFE_ACCESS](this.start + start, fixedLength);
  };

  public read(start = 0, length?: number): Uint8Array {
    return this[UNSAFE_ACCESS](start, length).slice();
  }

  public readByte(index: number): number {
    this.validateSelectParams(index);
    return this.facade.readByte(this.start + index);
  }

  public write(content: Uint8Array | IBufferFacade, offset = 0) {
    this.validateSelectParams(offset, content.byteLength);
    this.facade.write(content, this.start + offset);
    return this;
  }

  public writeByte(index: number, val: number) {
    this.validateSelectParams(index);
    this.facade.writeByte(this.start + index, val);
    return this;
  }

  public select(start = 0, length?: number): IBufferFacade {
    const fixedLength = this.validateSelectParams(start, length);
    return new SelectBufferFacade(this, start, fixedLength);
  }

  // return fixed length
  private validateSelectParams(
    start: number,
    length?: number,
  ): number | undefined {
    if (start < 0) {
      throw new Error(`Out of range`);
    }
    if (length !== undefined && length < 0) {
      throw new Error(`Invalid length`);
    }
    if (this.length === undefined) {
      return length;
    }
    if (length === undefined) {
      return this.length - start;
    }
    const end = start + length;
    if (end > this.length) {
      throw new Error(`Out of range`);
    }
    return length;
  }
}

export class GuardedBufferFacade implements IBufferFacade {
  private readonly facade: IBufferFacade;
  private readonly onGuard: IOnGuard;

  constructor(
    facade: IBufferFacade,
    onGuard: IOnGuard,
  ) {
    this.facade = facade;
    this.onGuard = onGuard;
  }

  public get byteLength() {
    this.onGuard("read");
    return this.facade.byteLength;
  }

  public [UNSAFE_ACCESS] = (start = 0, length?: number): Uint8Array => {
    this.onGuard("read");
    return this.facade[UNSAFE_ACCESS](start, length);
  };

  public read(start = 0, length?: number): Uint8Array {
    this.onGuard("read");
    return this.facade.read(start, length);
  }

  public readByte(index: number): number {
    this.onGuard("read");
    return this.facade.readByte(index);
  }

  public writeByte(index: number, val: number) {
    this.onGuard("write");
    this.facade.writeByte(index, val);
    return this;
  }

  public write(content: Uint8Array | IBufferFacade, offset = 0) {
    this.onGuard("write");
    this.facade.write(content, offset);
    return this;
  }

  public select(start = 0, length?: number): IBufferFacade {
    this.onGuard("select");
    return new SelectBufferFacade(this, start, length);
  }
}

export class TrackedBufferFacade extends GuardedBufferFacade {
  protected readonly dirtyManager: DirtyManager;

  constructor(
    facade: IBufferFacade,
    dirtyManager: DirtyManager = new DirtyManager(),
  ) {
    super(facade, (reason) => {
      if (reason === "write") {
        this.dirtyManager.markDirty();
      }
    });
    this.dirtyManager = dirtyManager;
  }

  public markClean() {
    this.dirtyManager.markClean();
  }
}

export class DynamicBufferFacade implements IBufferFacade {
  private facade: SimpleBufferFacade;

  constructor(buffer: Uint8Array = new Uint8Array(32)) {
    this.facade = new SimpleBufferFacade(buffer);
  }

  public get byteLength() {
    return this.facade.byteLength;
  }

  public [UNSAFE_ACCESS] = (start = 0, length?: number): Uint8Array => {
    return this.facade[UNSAFE_ACCESS](start, length);
  };

  public read(start = 0, length?: number): Uint8Array {
    return this.facade.read(start, length);
  }

  public readByte(index: number): number {
    return this.facade.readByte(index);
  }

  public writeByte(index: number, val: number) {
    this.expand(index + 1);
    this.facade.writeByte(index, val);
    return this;
  }

  public write(content: Uint8Array | IBufferFacade, offset = 0) {
    this.expand(offset + content.byteLength);
    this.facade.write(content, offset);
    return this;
  }

  public select(start = 0, length?: number): IBufferFacade {
    return new SelectBufferFacade(this, start, length);
  }

  /**
   * Expand the buffer to be at least minsize (size is always a power of 4)
   */
  public expand(minsize: number): this {
    if (minsize < this.facade.byteLength) {
      return this;
    }
    // we don't use current facade size bacause it might not be a power of 4
    let newsize = 32 * 4;
    while (newsize < minsize) {
      newsize *= 4;
    }
    const newBuffer = new Uint8Array(newsize);
    newBuffer.set(this.facade[UNSAFE_ACCESS]());
    this.facade = new SimpleBufferFacade(newBuffer);
    return this;
  }
}

export class PagedBufferFacade<PageInfo> implements IBufferFacade {
  private readonly getNextPage: IGetNextPage<PageInfo>;
  private readonly deleteNextPage: IDeleteNextPage<PageInfo>;
  private readonly initialPageInfo: PageInfo;
  // private readonly pages: Array<IPagedBufferFacadePage<PageInfo>> = [];
  // private complete: null | { byteLength?: number } = null;

  constructor(
    initialPageInfo: PageInfo,
    getNextPage: IGetNextPage<PageInfo>,
    deleteNextPage: IDeleteNextPage<PageInfo>,
  ) {
    this.getNextPage = getNextPage;
    this.initialPageInfo = initialPageInfo;
    this.deleteNextPage = deleteNextPage;
  }

  public get byteLength(): number {
    // if (this.complete && this.complete.byteLength !== undefined) {
    //   return this.complete.byteLength;
    // }
    let size = 0;
    let pageInfo = this.initialPageInfo;
    while (true) {
      const page = this.getNextPage(pageInfo, "read");
      if (page === null) {
        break;
      }
      size += page.buffer.byteLength;
      pageInfo = page.nextPageInfo;
    }
    // for (let pageIndex = 0; true; pageIndex++) {
    //   const page = this.getPage(pageIndex, "read");
    //   if (page === null) {
    //     break;
    //   }
    //   size += page.buffer.byteLength;
    // }
    // this.complete = { byteLength: size };
    return size;
  }

  public [UNSAFE_ACCESS] = (start = 0, length?: number): Uint8Array => {
    const resultLength = length ?? this.byteLength - start;
    const result = new Uint8Array(resultLength);
    let skipRest = start;
    let readRest = length ?? Infinity;
    let written = 0;
    let pageInfo = this.initialPageInfo;
    while (true) {
      const page = this.getNextPage(pageInfo, "read");
      if (page === null) {
        if (length === undefined) {
          break;
        }
        throw new Error(`Out of range read`);
      }
      pageInfo = page.nextPageInfo;
      const pageLength = page.buffer.byteLength;
      if (skipRest >= pageLength) {
        skipRest -= pageLength;
        continue;
      }
      const maxReadLength = pageLength - skipRest;
      // readpage
      const readSize = length === undefined
        ? maxReadLength
        : Math.min(maxReadLength, readRest);
      result.set(
        page.buffer[UNSAFE_ACCESS](skipRest, readSize),
        written,
      );
      skipRest = 0;
      written += readSize;
      readRest -= readSize;
      if (readRest === 0) {
        break;
      }
    }
    return result;
  };

  public read(start = 0, length?: number): Uint8Array {
    return this[UNSAFE_ACCESS](start, length).slice();
  }

  public readByte(index: number): number {
    let skipRest = index;
    let pageInfo = this.initialPageInfo;
    while (true) {
      const page = this.getNextPage(pageInfo, "read");
      if (page === null) {
        throw new Error(`Out of range read`);
      }
      pageInfo = page.nextPageInfo;
      const pageLength = page.buffer.byteLength;
      if (skipRest >= pageLength) {
        skipRest -= pageLength;
        continue;
      }
      return page.buffer.readByte(skipRest);
    }
  }

  public writeAndCleanup(content: IWriteValue, offset = 0): this {
    return this.writeInternal(content, offset, true);
  }

  public write(content: IWriteValue, offset = 0): this {
    return this.writeInternal(content, offset, false);
  }

  public writeByte(index: number, val: number): this {
    let skipRest = index;
    let pageInfo = this.initialPageInfo;
    while (true) {
      const page = this.getNextPage(pageInfo, "write");
      if (page === null) {
        throw new Error(`Out of range read`);
      }
      pageInfo = page.nextPageInfo;
      const pageLength = page.buffer.byteLength;
      if (skipRest >= pageLength) {
        skipRest -= pageLength;
        continue;
      }
      page.buffer.writeByte(skipRest, val);
      return this;
    }
  }

  public select(start = 0, length?: number): IBufferFacade {
    return new SelectBufferFacade(this, start, length);
  }

  // protected resetComplete() {
  //   this.complete = null;
  // }

  // private cleanupPage(index: number): void {
  //   const page = this.getPage(index, "read");
  //   if (page === null) {
  //     return;
  //   }
  //   // const nextIndex = index + 1;
  //   // this.pages.splice(nextIndex, this.pages.length - nextIndex);
  //   // this.resetComplete();
  //   this.deleteNextPage(page.nextPageInfo);
  // }

  // private getPage(
  //   pageInfo: PageInfo,
  //   reason: "read" | "write",
  // ): null | IPagedBufferFacadePage<PageInfo> {
  //   // const cached = this.pages[index];
  //   // if (cached) {
  //   //   return cached;
  //   // }
  //   // if (this.complete) {
  //   //   return null;
  //   // }
  //   // const lastPageIndex = this.pages.length - 1;
  //   while (this.pages.length <= index) {
  //     const pageInfo = lastPageIndex === -1
  //       ? this.initialPageInfo
  //       : this.pages[lastPageIndex].nextPageInfo;
  //     const page = this.getNextPage(pageInfo, reason);
  //     if (page === null) {
  //       this.complete = {};
  //       break;
  //     }
  //     this.pages.push(page);
  //   }
  //   if (this.pages[index]) {
  //     return this.pages[index];
  //   }
  //   return null;
  // }

  private writeInternal(
    content: Uint8Array | IBufferFacade,
    offset: number,
    cleanup: boolean,
  ): this {
    let skipRest = offset;
    let writeRest: Uint8Array = content instanceof Uint8Array
      ? content
      : content[UNSAFE_ACCESS]();
    let pageInfo = this.initialPageInfo;
    while (true) {
      const page = this.getNextPage(pageInfo, "write");
      if (page === null) {
        throw new Error(`Out of range write`);
      }
      pageInfo = page.nextPageInfo;
      const pageLength = page.buffer.byteLength;
      if (skipRest >= pageLength) {
        skipRest -= pageLength;
        continue;
      }
      // write page
      const maxWriteLength = pageLength - skipRest;
      const writeSize = Math.min(maxWriteLength, writeRest.byteLength);
      page.buffer.write(writeRest.subarray(0, writeSize), skipRest);
      writeRest = writeRest.subarray(writeSize);
      skipRest = 0;
      if (writeRest.byteLength === 0) {
        break;
      }
    }
    if (cleanup) {
      this.deleteNextPage(pageInfo);
    }
    return this;
  }
}

export class JoinedBufferFacade extends PagedBufferFacade<number> {
  private readonly buffers: Array<IBufferFacade>;
  private totalSize: number;

  constructor(buffers: Array<IBufferFacade> = []) {
    super(0, (index) => {
      if (index >= this.buffers.length) {
        return null;
      }
      return { buffer: this.buffers[index], nextPageInfo: index + 1 };
    }, () => {});
    this.buffers = buffers;
    this.totalSize = buffers.reduce((acc, buf) => acc + buf.byteLength, 0);
  }

  public get byteLength(): number {
    return this.totalSize;
  }

  public add(buffer: IBufferFacade) {
    this.buffers.push(buffer);
    this.totalSize += buffer.byteLength;
  }
}

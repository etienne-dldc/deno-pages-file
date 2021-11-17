import { PageBuffer } from "./PageBuffer.ts";

export enum PageType {
  Empty = 0,
  Root = 1,
  Emptylist = 2,
  Data = 3,
  Entry = 4,
}

export class Page {
  public readonly type: PageType | number;
  public readonly pageSize: number;
  public readonly addr: number;
  public readonly contentLenth: number;
  public readonly contentOffset: number;

  protected readonly buffer: PageBuffer;

  protected isDirty: boolean;
  protected isDeleted = false;

  constructor(
    pageSize: number,
    addr: number,
    buffer: Uint8Array,
    type: PageType | number,
    isDirty: boolean
  ) {
    this.addr = addr;
    this.pageSize = pageSize;
    this.type = type;
    this.isDirty = isDirty;
    // start at pos 1 to skip type
    this.buffer = new PageBuffer(buffer, 1, () => {
      if (this.isDeleted) {
        throw new Error("Cannot write on deleted page");
      }
      this.isDirty = true;
    });
    this.contentOffset = this.buffer.position;
    this.contentLenth = this.pageSize - this.contentOffset;
  }

  public get dirty(): boolean {
    return this.isDirty;
  }

  public markDeleted() {
    if (this.isDeleted) {
      return;
    }
    this.isDeleted = true;
  }

  // return a new buffer with the content
  public getContent(): PageBuffer {
    return this.buffer
      .seek(this.contentOffset)
      .read.pageBuffer(this.contentLenth);
  }

  public setContent(content: Uint8Array): void {
    if (content.byteLength > this.contentLenth) {
      throw new Error(`Payload too large`);
    }
    return this.buffer.seek(this.contentOffset).write.buffer(content);
  }

  public writeTo(file: Deno.File) {
    if (this.isDirty === false) {
      return;
    }
    const offset = this.pageSize * this.addr;
    file.seekSync(offset, Deno.SeekMode.Start);
    for (let i = 0; i < this.pageSize; ) {
      const nwrite = file.writeSync(this.buffer.subarray(i));
      if (nwrite <= 0) {
        throw new Error("Unexpected return value of write(): " + nwrite);
      }
      i += nwrite;
    }
    this.isDirty = false;
  }
}

// type | nextPage | header | content
export class OldPage {
  public readonly addr: number;
  public readonly contentLenth: number;
  public readonly contentOffset: number;
  public readonly nextAddrOffset: number;
  public readonly headerLenth: number;
  public readonly headerOffset: number;
  public readonly pageSize: number;
  public readonly type: PageType | number;

  protected readonly buffer: PageBuffer;

  protected isDirty: boolean;
  protected isDeleted = false;
  protected nextAddrInternal: number;

  constructor(
    pageSize: number,
    addr: number,
    buffer: Uint8Array,
    type: PageType | number,
    isDirty: boolean,
    headerLenth: number
  ) {
    this.addr = addr;
    this.pageSize = pageSize;
    this.type = type;
    this.isDirty = isDirty;
    this.buffer = new PageBuffer(buffer, 1, () => {
      if (this.isDeleted) {
        throw new Error("Cannot write on deleted page");
      }
      this.isDirty = true;
    });
    this.nextAddrOffset = this.buffer.position;
    this.nextAddrInternal = this.buffer.readNext.uint16();
    this.headerOffset = this.buffer.position;
    this.headerLenth = headerLenth;
    this.contentOffset = this.buffer.position + headerLenth;
    this.contentLenth = this.pageSize - this.contentOffset;
  }

  public get dirty(): boolean {
    return this.isDirty;
  }

  public get nextAddr() {
    return this.nextAddrInternal;
  }

  public set nextAddr(addr: number) {
    if (addr === this.nextAddrInternal) {
      return;
    }
    this.nextAddrInternal = addr;
    this.seekToNextAddr().writeNext.uint16(addr);
  }

  public markDeleted() {
    if (this.isDeleted) {
      return;
    }
    this.isDeleted = true;
  }

  // return a new buffer with the content
  public getContent(): PageBuffer {
    return this.buffer
      .seek(this.contentOffset)
      .read.pageBuffer(this.contentLenth);
  }

  public setContent(content: Uint8Array): void {
    if (content.byteLength > this.contentLenth) {
      throw new Error(`Payload too large`);
    }
    return this.buffer.seek(this.contentOffset).write.buffer(content);
  }

  public writeTo(file: Deno.File) {
    if (this.isDirty === false) {
      return;
    }
    const offset = this.pageSize * this.addr;
    file.seekSync(offset, Deno.SeekMode.Start);
    for (let i = 0; i < this.pageSize; ) {
      const nwrite = file.writeSync(this.buffer.subarray(i));
      if (nwrite <= 0) {
        throw new Error("Unexpected return value of write(): " + nwrite);
      }
      i += nwrite;
    }
    this.isDirty = false;
  }

  protected seekToNextAddr(): PageBuffer {
    return this.buffer.seek(this.nextAddrOffset);
  }

  protected seekToHeader(): PageBuffer {
    return this.buffer.seek(this.headerOffset);
  }

  protected seekToContent(): PageBuffer {
    return this.buffer.seek(this.contentOffset);
  }
}

// Header: pageSize(2) | emptylistAddr(2)
export class RootPage extends Page {
  protected emptylistAddrInternal: number;
  protected emptylistAddrOffsetInternal: number;

  constructor(pageSize: number, buffer: Uint8Array, isNew: boolean) {
    const headerLenth = 4; // pageSize(2) | emptylistAddr(2)
    super(pageSize, 0, buffer, PageType.Root, isNew, headerLenth);
    // read or write page size
    if (isNew) {
      this.buffer.writeNext.uint16(pageSize);
    } else {
      const storedPageSize = this.buffer.readNext.uint16();
      if (pageSize !== storedPageSize) {
        throw new Error(`Page size mismatch ${pageSize} === ${storedPageSize}`);
      }
    }
    this.emptylistAddrOffsetInternal = this.buffer.position;
    this.emptylistAddrInternal = this.buffer.readNext.uint16();
  }

  public get emptylistAddr() {
    return this.emptylistAddrInternal;
  }

  public set emptylistAddr(addr: number) {
    if (addr === this.emptylistAddrInternal) {
      return;
    }
    this.emptylistAddrInternal = addr;
    this.buffer.seek(this.emptylistAddrOffsetInternal).writeNext.uint16(addr);
  }
}

export class EmptylistPage extends Page {
  public readonly capacity: number;

  protected prevAddrInternal: number;
  protected countInternal: number;
  protected countOffsetInternal: number;
  protected emptyPagesInternal: Array<number> = [];

  constructor(
    pageSize: number,
    addr: number,
    buffer: Uint8Array,
    isNew: boolean
  ) {
    const headerLenth = 4; // prevAddr(2) | count(2)
    super(pageSize, addr, buffer, PageType.Emptylist, isNew, headerLenth);
    this.prevAddrInternal = this.buffer.readNext.uint16();
    this.countOffsetInternal = this.buffer.position;
    this.countInternal = this.buffer.readNext.uint16();
    this.capacity = Math.floor(this.contentLenth / 2); // 2 byte per addr
    while (this.emptyPagesInternal.length < this.countInternal) {
      this.emptyPagesInternal.push(this.buffer.readNext.uint16());
    }
  }

  public get prevAddr() {
    return this.prevAddrInternal;
  }

  public set prevAddr(addr: number) {
    if (addr === this.prevAddrInternal) {
      return;
    }
    this.prevAddrInternal = addr;
    this.seekToHeader().writeNext.uint16(addr);
  }

  public get count() {
    return this.countInternal;
  }

  public get empty() {
    return this.emptyPagesInternal.length === 0;
  }

  public get full() {
    return this.emptyPagesInternal.length === this.capacity;
  }

  public get emptyPages(): ReadonlyArray<number> {
    return [...this.emptyPagesInternal];
  }

  public pop(): number {
    if (this.countInternal === 0) {
      throw new Error(`Cannot pop empty list: no addrs`);
    }
    this.countInternal -= 1;
    this.buffer
      .seek(this.countOffsetInternal)
      .writeNext.uint16(this.countInternal);
    const poped = this.emptyPagesInternal.pop();
    if (poped === undefined) {
      throw new Error(`Pop returned undefied`);
    }
    return poped;
  }

  public push(addr: number): void {
    if (this.full) {
      throw new Error("Cannot push into full empty list");
    }
    const pos = this.contentOffset + 2 * this.emptyPagesInternal.length;
    this.buffer.seek(pos).write.uint16(addr);
    this.countInternal += 1;
    this.emptyPagesInternal.push(addr);
  }
}

export class DataPage extends Page {
  protected prevAddrInternal: number;

  constructor(
    pageSize: number,
    addr: number,
    buffer: Uint8Array,
    isNew: boolean
  ) {
    const headerLenth = 2; // prevPageIndex
    super(pageSize, addr, buffer, PageType.Data, isNew, headerLenth);

    this.prevAddrInternal = this.buffer.readNext.uint16();
  }

  public get prevAddr() {
    return this.prevAddrInternal;
  }

  public set prevAddr(addr: number) {
    if (addr === this.prevAddrInternal) {
      return;
    }
    this.prevAddrInternal = addr;
    this.seekToHeader().writeNext.uint16(addr);
  }
}

export class EntryPage extends Page {
  constructor(
    pageSize: number,
    addr: number,
    buffer: Uint8Array,
    type: number,
    isNew: boolean,
    headerLenth: number = 0
  ) {
    if (type < PageType.Entry) {
      throw new Error(`Inavlid page type`);
    }
    super(pageSize, addr, buffer, type, isNew, headerLenth);
  }
}

export class EmptyPage extends Page {
  constructor(pageSize: number, addr: number) {
    super(pageSize, addr, new Uint8Array(pageSize), PageType.Empty, true, 0);
  }
}

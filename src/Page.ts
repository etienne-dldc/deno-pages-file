import { PageBuffer } from "./PageBuffer.ts";

export enum PageType {
  Empty = 0,
  Root = 1,
  Emptylist = 2,
  Data = 3,
  Entry = 4,
}

// type | nextPage | header | content
export class Page {
  public readonly addr: number;
  public readonly contentLenth: number;
  public readonly contentOffset: number;
  public readonly nextAddrOffset: number;
  public readonly headerLenth: number;
  public readonly headerOffset: number;
  public readonly pageSize: number;

  protected readonly buffer: PageBuffer;

  #dirty: boolean;
  #nextAddr: number;
  #type: PageType | number;

  constructor(
    pageSize: number,
    addr: number,
    buffer: Uint8Array,
    type: PageType | number,
    isCreated: boolean,
    headerLenth: number
  ) {
    this.addr = addr;
    this.pageSize = pageSize;
    this.#type = type;
    this.#dirty = isCreated;
    this.buffer = new PageBuffer(buffer, 1, () => {
      this.#dirty = true;
      if (this.#type === PageType.Empty) {
        throw new Error("Cannot write on cleared page");
      }
    });
    this.nextAddrOffset = this.buffer.position;
    this.#nextAddr = this.buffer.readNext.uint16();
    this.headerOffset = this.buffer.position;
    this.headerLenth = headerLenth;
    this.contentOffset = this.buffer.position + headerLenth;
    this.contentLenth = this.pageSize - this.contentOffset;
  }

  get type(): PageType | number {
    return this.#type;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  get nextAddr() {
    return this.#nextAddr;
  }

  set nextAddr(addr: number) {
    if (addr === this.#nextAddr) {
      return;
    }
    this.#nextAddr = addr;
    this.seekToNextAddr().writeNext.uint16(addr);
  }

  clear() {
    if (this.#type === PageType.Empty) {
      return;
    }
    this.buffer.seek(0).writeNext.uint8(PageType.Empty);
    this.buffer.write.buffer(new Uint8Array(this.pageSize - 1));
    this.#type = PageType.Empty;
  }

  // return a new buffer with the content
  getContent(): PageBuffer {
    return this.buffer
      .seek(this.contentOffset)
      .read.pageBuffer(this.contentLenth);
  }

  setContent(content: Uint8Array): void {
    if (content.byteLength > this.contentLenth) {
      throw new Error(`Payload too large`);
    }
    return this.buffer.seek(this.contentOffset).write.buffer(content);
  }

  writeTo(file: Deno.File) {
    if (this.#dirty === false) {
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
    this.#dirty = false;
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
  #emptylistAddr: number;
  #emptylistAddrOffset: number;

  constructor(pageSize: number, buffer: Uint8Array, isCreated: boolean) {
    const headerLenth = 4; // pageSize(2) | emptylistAddr(2)
    super(pageSize, 0, buffer, PageType.Root, isCreated, headerLenth);
    // read or write page size
    if (isCreated) {
      this.buffer.writeNext.uint16(pageSize);
    } else {
      const storedPageSize = this.buffer.readNext.uint16();
      if (pageSize !== storedPageSize) {
        throw new Error(`Page size mismatch ${pageSize} === ${storedPageSize}`);
      }
    }
    this.#emptylistAddrOffset = this.buffer.position;
    this.#emptylistAddr = this.buffer.readNext.uint16();
  }

  get emptylistAddr() {
    return this.#emptylistAddr;
  }

  set emptylistAddr(addr: number) {
    if (addr === this.#emptylistAddr) {
      return;
    }
    this.#emptylistAddr = addr;
    this.buffer.seek(this.#emptylistAddrOffset).writeNext.uint16(addr);
  }
}

export class EmptylistPage extends Page {
  #prevAddr: number;
  #count: number;
  #countOffset: number;
  #emptyPages: Array<number> = [];
  #capacity: number;

  constructor(
    pageSize: number,
    addr: number,
    buffer: Uint8Array,
    isCreated: boolean
  ) {
    const headerLenth = 4; // prevAddr(2) | count(2)
    super(pageSize, addr, buffer, PageType.Emptylist, isCreated, headerLenth);
    this.#prevAddr = this.buffer.readNext.uint16();
    this.#countOffset = this.buffer.position;
    this.#count = this.buffer.readNext.uint16();
    this.#capacity = Math.floor(this.contentLenth / 2); // 2 byte per addr
    while (this.#emptyPages.length < this.#count) {
      this.#emptyPages.push(this.buffer.readNext.uint16());
    }
  }

  get prevAddr() {
    return this.#prevAddr;
  }

  set prevAddr(addr: number) {
    if (addr === this.#prevAddr) {
      return;
    }
    this.#prevAddr = addr;
    this.seekToHeader().writeNext.uint16(addr);
  }

  get count() {
    return this.#count;
  }

  get empty() {
    return this.#emptyPages.length === 0;
  }

  get full() {
    return this.#emptyPages.length === this.#capacity;
  }

  get emptyPages(): ReadonlyArray<number> {
    return [...this.#emptyPages];
  }

  public pop(): number {
    if (this.#count === 0) {
      throw new Error(`Cannot pop empty list: no addrs`);
    }
    this.#count -= 1;
    this.buffer.seek(this.#countOffset).writeNext.uint16(this.#count);
    const poped = this.#emptyPages.pop();
    if (poped === undefined) {
      throw new Error(`Pop returned undefied`);
    }
    return poped;
  }

  public push(addr: number): void {
    if (this.full) {
      throw new Error("Cannot push into full empty list");
    }
    const pos = this.contentOffset + 2 * this.#emptyPages.length;
    this.buffer.seek(pos).write.uint16(addr);
    this.#count += 1;
    this.#emptyPages.push(addr);
  }
}

export class DataPage extends Page {
  #prevAddr: number;

  constructor(
    pageSize: number,
    addr: number,
    buffer: Uint8Array,
    isCreated: boolean
  ) {
    const headerLenth = 2; // prevPageIndex
    super(pageSize, addr, buffer, PageType.Data, isCreated, headerLenth);

    this.#prevAddr = this.buffer.readNext.uint16();
  }

  get prevAddr() {
    return this.#prevAddr;
  }

  set prevAddr(addr: number) {
    if (addr === this.#prevAddr) {
      return;
    }
    this.#prevAddr = addr;
    this.seekToHeader().writeNext.uint16(addr);
  }
}

export class EntryPage extends Page {
  constructor(
    pageSize: number,
    addr: number,
    buffer: Uint8Array,
    expectedType: number,
    isCreated: boolean
  ) {
    if (
      expectedType === PageType.Root ||
      expectedType === PageType.Emptylist ||
      expectedType === PageType.Data
    ) {
      throw new Error(`Inavlid page type`);
    }
    const headerLenth = 0;
    super(pageSize, addr, buffer, expectedType, isCreated, headerLenth);
  }
}

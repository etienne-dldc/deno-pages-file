import { Block } from "./BufferBlock.ts";
import {
  BlocksFixedAny,
  FixedBlockList,
  ReadBlock,
  WriteBlock,
} from "./BufferBlock.ts";
import { DirtyManager } from "./DirtyManager.ts";

export enum PageType {
  Empty = 0,
  Root = 1,
  Emptylist = 2,
  Data = 3,
  Entry = 4,
}

export type PageAny = Page<BlocksFixedAny>;

export class Page<HeaderBlocks extends BlocksFixedAny> {
  public readonly type: PageType | number;
  public readonly pageSize: number;
  public readonly addr: number;

  protected readonly blocks: FixedBlockList<HeaderBlocks>;
  protected readonly dirtyManager: DirtyManager;
  protected isDeleted = false;

  private readonly buffer: Uint8Array;

  constructor(
    pageSize: number,
    addr: number,
    buffer: Uint8Array,
    headerBlocks: HeaderBlocks,
    type: PageType | number,
    isDirty: boolean,
  ) {
    this.addr = addr;
    this.pageSize = pageSize;
    this.type = type;
    this.buffer = buffer;
    this.dirtyManager = new DirtyManager(isDirty);
    this.blocks = new FixedBlockList(
      buffer.subarray(1),
      headerBlocks,
      this.dirtyManager,
    );
  }

  public get dirty(): boolean {
    return this.blocks.dirty;
  }

  public get contentLength(): number {
    return this.blocks.restLength;
  }

  public markDeleted() {
    if (this.isDeleted) {
      return;
    }
    this.isDeleted = true;
  }

  // return a new buffer with the content
  public readContent(): Uint8Array {
    return this.blocks.readRest();
  }

  public writeContent(content: Uint8Array): void {
    this.blocks.writeRest(content);
  }

  public writeTo(file: Deno.File) {
    if (this.dirtyManager.dirty === false) {
      return;
    }
    const offset = this.pageSize * this.addr;
    file.seekSync(offset, Deno.SeekMode.Start);
    for (let i = 0; i < this.pageSize;) {
      const nwrite = file.writeSync(this.buffer.subarray(i));
      if (nwrite <= 0) {
        throw new Error("Unexpected return value of write(): " + nwrite);
      }
      i += nwrite;
    }
    this.dirtyManager.markClean();
  }
}

export class EmptyPage extends Page<[]> {
  constructor(pageSize: number, addr: number) {
    super(pageSize, addr, new Uint8Array(pageSize), [], PageType.Empty, true);
  }
}

const ROOT_HEADER_BLOCKS = [
  FixedBlockList.named("pageSize", Block.uint16),
  FixedBlockList.named("emptylistAddr", Block.uint16),
  FixedBlockList.named("nextPage", Block.uint16),
] as const;

export class RootPage extends Page<typeof ROOT_HEADER_BLOCKS> {
  constructor(pageSize: number, buffer: Uint8Array, isNew: boolean) {
    super(pageSize, 0, buffer, ROOT_HEADER_BLOCKS, PageType.Root, isNew);
    if (isNew) {
      this.blocks.write("pageSize", pageSize);
    } else {
      const storedPageSize = this.blocks.read("pageSize");
      if (pageSize !== storedPageSize) {
        throw new Error(`Page size mismatch ${pageSize} === ${storedPageSize}`);
      }
    }
  }

  public get nextPage() {
    return this.blocks.read("nextPage");
  }

  public set nextPage(addr: number) {
    this.blocks.write("nextPage", addr);
  }

  public get emptylistAddr() {
    return this.blocks.read("emptylistAddr");
  }

  public set emptylistAddr(addr: number) {
    this.blocks.write("emptylistAddr", addr);
  }
}

const EMPTYLIST_HEADER_BLOCKS = [
  FixedBlockList.named("prevPage", Block.uint16),
  FixedBlockList.named("nextPage", Block.uint16),
  FixedBlockList.named("count", Block.uint16),
] as const;

export class EmptylistPage extends Page<typeof EMPTYLIST_HEADER_BLOCKS> {
  public readonly capacity: number;

  constructor(
    pageSize: number,
    addr: number,
    buffer: Uint8Array,
    isNew: boolean,
  ) {
    super(
      pageSize,
      addr,
      buffer,
      EMPTYLIST_HEADER_BLOCKS,
      PageType.Emptylist,
      isNew,
    );
    this.capacity = Math.floor(this.blocks.restLength / ReadBlock.uint16.size); // 2 byte per addrs
  }

  public get prevPage() {
    return this.blocks.read("prevPage");
  }

  public set prevPage(addr: number) {
    this.blocks.write("prevPage", addr);
  }

  public get nextPage() {
    return this.blocks.read("nextPage");
  }

  public set nextPage(addr: number) {
    this.blocks.write("nextPage", addr);
  }

  public get count() {
    return this.blocks.read("count");
  }

  public get empty() {
    return this.count === 0;
  }

  public get full() {
    return this.count === this.capacity;
  }

  public pop(): number {
    const currentCount = this.count;
    if (currentCount === 0) {
      throw new Error(`Cannot pop empty list: no addrs`);
    }
    this.blocks.write("count", currentCount - 1);
    const offset = (currentCount - 1) * ReadBlock.uint16.size;
    const poped = ReadBlock.uint16.read(this.blocks.readRest(), offset);
    if (poped === 0) {
      throw new Error(`Found 0 in freelist ?`);
    }
    this.dirtyManager.markDirty();
    return poped;
  }

  public push(addr: number): void {
    if (this.full) {
      throw new Error("Cannot push into full empty list");
    }
    const currentCount = this.count;
    this.blocks.write("count", currentCount + 1);
    const offset = currentCount * ReadBlock.uint16.size;
    WriteBlock.uint16.write(this.blocks.readRest(), offset, addr);
    this.dirtyManager.markDirty();
  }

  public readAtIndex(index: number): number {
    if (index >= this.count) {
      throw new Error(`Out of bound read`);
    }
    const offset = (index) * ReadBlock.uint16.size;
    return ReadBlock.uint16.read(this.blocks.readRest(), offset);
  }
}

const DATA_HEADER_BLOCKS = [
  FixedBlockList.named("prevPage", Block.uint16),
  FixedBlockList.named("nextPage", Block.uint16),
] as const;

export class DataPage extends Page<typeof DATA_HEADER_BLOCKS> {
  constructor(
    pageSize: number,
    addr: number,
    buffer: Uint8Array,
    isNew: boolean,
  ) {
    super(pageSize, addr, buffer, DATA_HEADER_BLOCKS, PageType.Data, isNew);
  }

  public get prevPage() {
    return this.blocks.read("prevPage");
  }

  public set prevPage(addr: number) {
    this.blocks.write("prevPage", addr);
  }

  public get nextPage() {
    return this.blocks.read("nextPage");
  }

  public set nextPage(addr: number) {
    this.blocks.write("nextPage", addr);
  }
}

const ENTRY_HEADER_BLOCKS = [
  FixedBlockList.named("prevPage", Block.uint16),
  FixedBlockList.named("nextPage", Block.uint16),
] as const;

export class EntryPage extends Page<typeof ENTRY_HEADER_BLOCKS> {
  constructor(
    pageSize: number,
    addr: number,
    buffer: Uint8Array,
    type: number,
    isNew: boolean,
  ) {
    if (type < PageType.Entry) {
      throw new Error(`Inavlid page type`);
    }
    super(pageSize, addr, buffer, ENTRY_HEADER_BLOCKS, type, isNew);
  }

  public get nextPage() {
    return this.blocks.read("nextPage");
  }

  public set nextPage(addr: number) {
    this.blocks.write("nextPage", addr);
  }
}

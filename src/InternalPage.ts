import {
  Block,
  BUFFER_FACADE_UNSAFE_ACCESS,
  DirtyManager,
  FixedBlockList,
  IBufferFacade,
  ReadBlock,
  SimpleBufferFacade,
  TrackedBufferFacade,
  WriteBlock,
} from "./buffer/mod.ts";

export enum PageType {
  Empty = 0,
  Root = 1,
  Emptylist = 2,
  Data = 3,
  Entry = 4,
}

export class RawInternalPage {
  public readonly pageSize: number;
  public readonly addr: number;
  public readonly type: PageType | number;
  public readonly contentFacade: IBufferFacade;

  private readonly dirtyManager: DirtyManager;
  private readonly fullFacade: TrackedBufferFacade;
  private isDeleted = false;

  constructor(
    pageSize: number,
    addr: number,
    buffer: Uint8Array,
    type: PageType | number,
    isDirty: boolean,
  ) {
    this.pageSize = pageSize;
    this.addr = addr;
    this.type = type;
    this.dirtyManager = new DirtyManager(isDirty);
    this.fullFacade = new TrackedBufferFacade(
      new SimpleBufferFacade(buffer),
      this.dirtyManager,
    );
    this.contentFacade = this.fullFacade.select(1); // skip page type byte
  }

  public get dirty(): boolean {
    return this.dirtyManager.dirty;
  }

  public get deleted(): boolean {
    return this.isDeleted;
  }

  public markDeleted() {
    if (this.isDeleted) {
      return;
    }
    this.isDeleted = true;
  }

  public writeTo(file: Deno.File) {
    if (this.isDeleted) {
      throw new Error(`Cannot write deleted page`);
    }
    if (this.dirtyManager.dirty === false) {
      return;
    }
    const offset = this.pageSize * this.addr;
    file.seekSync(offset, Deno.SeekMode.Start);
    for (let i = 0; i < this.pageSize;) {
      const nwrite = file.writeSync(
        this.fullFacade[BUFFER_FACADE_UNSAFE_ACCESS](i),
      );
      if (nwrite <= 0) {
        throw new Error("Unexpected return value of write(): " + nwrite);
      }
      i += nwrite;
    }
    this.dirtyManager.markClean();
  }
}

export class InternalPage {
  public readonly pageSize: number;
  public readonly addr: number;
  public readonly type: PageType | number;

  private readonly parent: RawInternalPage;

  constructor(parent: RawInternalPage) {
    this.parent = parent;
    this.pageSize = parent.pageSize;
    this.addr = parent.addr;
    this.type = parent.type;
  }

  public get dirty(): boolean {
    return this.parent.dirty;
  }

  public get deleted(): boolean {
    return this.parent.deleted;
  }

  public markDeleted() {
    this.parent.markDeleted();
  }

  public writeTo(file: Deno.File): void {
    this.parent.writeTo(file);
  }
}

export class InternalEmptyPage extends InternalPage {
  constructor(pageSize: number, addr: number) {
    const buffer = new Uint8Array(pageSize); // buffer[0] is 0 which correspond to PageType.Empty
    const parent = new RawInternalPage(
      pageSize,
      addr,
      buffer,
      PageType.Empty,
      true,
    );
    super(parent);
  }
}

const ROOT_HEADER = [
  FixedBlockList.named("pageSize", Block.uint16),
  FixedBlockList.named("emptylistAddr", Block.uint16),
  FixedBlockList.named("nextPage", Block.uint16),
] as const;

export class InternalRootPage extends InternalPage {
  public readonly contentFacade: IBufferFacade;

  private readonly blocks: FixedBlockList<typeof ROOT_HEADER>;

  constructor(parent: RawInternalPage, isNew: boolean) {
    super(parent);
    this.blocks = new FixedBlockList(ROOT_HEADER, parent.contentFacade);
    this.contentFacade = this.blocks.selectRest();
    if (isNew) {
      this.blocks.write("pageSize", parent.pageSize);
    } else {
      const storedPageSize = this.blocks.read("pageSize");
      if (parent.pageSize !== storedPageSize) {
        throw new Error(
          `Page size mismatch ${parent.pageSize} === ${storedPageSize}`,
        );
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

export class InternalEmptylistPage extends InternalPage {
  public readonly capacity: number;

  private readonly blocks: FixedBlockList<typeof EMPTYLIST_HEADER_BLOCKS>;
  private readonly contentFacade: IBufferFacade;

  constructor(parent: RawInternalPage) {
    super(parent);
    this.blocks = new FixedBlockList(
      EMPTYLIST_HEADER_BLOCKS,
      parent.contentFacade,
    );
    this.capacity = Math.floor(this.blocks.restLength / ReadBlock.uint16.size); // 2 byte per addrs
    this.contentFacade = this.blocks.selectRest();
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
    const poped = ReadBlock.uint16.read(this.contentFacade, offset);
    if (poped === 0) {
      throw new Error(`Found 0 in freelist ?`);
    }
    return poped;
  }

  public push(addr: number): void {
    if (this.full) {
      throw new Error("Cannot push into full empty list");
    }
    const currentCount = this.count;
    this.blocks.write("count", currentCount + 1);
    const offset = currentCount * ReadBlock.uint16.size;
    WriteBlock.uint16.write(this.contentFacade, offset, addr);
  }

  public readAtIndex(index: number): number {
    if (index >= this.count) {
      throw new Error(`Out of bound read`);
    }
    const offset = (index) * ReadBlock.uint16.size;
    return ReadBlock.uint16.read(this.contentFacade, offset);
  }
}

const DATA_HEADER_BLOCKS = [
  FixedBlockList.named("prevPage", Block.uint16),
  FixedBlockList.named("nextPage", Block.uint16),
] as const;

export class InternalDataPage extends InternalPage {
  public readonly contentFacade: IBufferFacade;

  private readonly blocks: FixedBlockList<typeof DATA_HEADER_BLOCKS>;

  constructor(parent: RawInternalPage) {
    super(parent);
    this.blocks = new FixedBlockList(DATA_HEADER_BLOCKS, parent.contentFacade);
    this.contentFacade = this.blocks.selectRest();
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

export class InternalEntryPage extends InternalPage {
  public readonly contentFacade: IBufferFacade;

  private readonly blocks: FixedBlockList<typeof ENTRY_HEADER_BLOCKS>;

  constructor(parent: RawInternalPage) {
    if (parent.type < PageType.Entry) {
      throw new Error(`Invalid page type`);
    }
    super(parent);
    this.blocks = new FixedBlockList(ENTRY_HEADER_BLOCKS, parent.contentFacade);
    this.contentFacade = this.blocks.selectRest();
  }

  public get nextPage() {
    return this.blocks.read("nextPage");
  }

  public set nextPage(addr: number) {
    this.blocks.write("nextPage", addr);
  }
}

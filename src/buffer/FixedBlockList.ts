// deno-lint-ignore-file no-explicit-any
import { DirtyManager } from "./DirtyManager.ts";
import { IBlockFixed } from "./types.d.ts";

export type BlockNamed<N extends string, Value> = {
  name: N;
  block: IBlockFixed<Value>;
};

export type BlockNamedAny = BlockNamed<string, any>;

export type BlocksFixedAny = ReadonlyArray<BlockNamedAny>;

export type BlockNames<Schema extends BlocksFixedAny> = Schema[number]["name"];

export type BlockValueByName<
  Schema extends BlocksFixedAny,
  Name extends Schema[number]["name"],
> = Extract<Schema[number], { name: Name }> extends BlockNamed<string, infer V>
  ? V
  : never;

export type FixedBlockListItem = { offset: number; block: IBlockFixed<any> };

export class FixedBlockList<FixedBlocks extends BlocksFixedAny> {
  public static named<N extends string, Value>(
    name: N,
    block: IBlockFixed<Value>,
  ): BlockNamed<N, Value> {
    return { name, block };
  }

  public readonly schema: FixedBlocks;

  private readonly buffer: Uint8Array;
  private readonly byName = new Map<string, FixedBlockListItem>();
  private readonly lastOffset: number;

  private readonly dirtyManager: DirtyManager;

  constructor(
    buffer: Uint8Array,
    schema: FixedBlocks,
    dirtyManager: DirtyManager = new DirtyManager(),
  ) {
    this.buffer = buffer;
    this.schema = schema;
    this.dirtyManager = dirtyManager;
    let offset = 0;
    schema.forEach(({ name, block }) => {
      if (this.byName.has(name)) {
        throw new Error(`Duplicate name "${name}"`);
      }
      if (block.read.size !== block.write.size) {
        throw new Error(`Read / Write mismatch for "${name}"`);
      }
      this.byName.set(name, { offset, block });
      offset += block.read.size;
    });
    this.lastOffset = offset;
  }

  public get fixedLength() {
    return this.lastOffset;
  }

  public get restOffset() {
    return this.lastOffset;
  }

  public get restLength() {
    return this.buffer.byteLength - this.lastOffset;
  }

  public get dirty() {
    return this.dirtyManager.dirty;
  }

  public markClean() {
    this.dirtyManager.markClean();
  }

  public read<N extends BlockNames<FixedBlocks>>(
    name: N,
  ): BlockValueByName<FixedBlocks, N> {
    const obj = this.byName.get(name);
    if (!obj) {
      throw new Error(`Invalid name "${name}"`);
    }
    const value = obj.block.read.read(this.buffer, obj.offset);
    return value;
  }

  public write<N extends BlockNames<FixedBlocks>>(
    name: N,
    value: BlockValueByName<FixedBlocks, N>,
  ): this {
    const obj = this.byName.get(name);
    if (!obj) {
      throw new Error(`Invalid name "${name}"`);
    }
    obj.block.write.write(this.buffer, obj.offset, value);
    this.dirtyManager.markDirty();
    return this;
  }

  public readRest(): Uint8Array {
    return this.buffer.subarray(this.restOffset);
  }

  public writeRest(content: Uint8Array): this {
    if (content.byteLength > this.restLength) {
      throw new Error(
        `Cannot write buffer of size ${content.byteLength} into rest of size ${this.restLength}`,
      );
    }
    this.buffer.set(content, this.lastOffset);
    this.dirtyManager.markDirty();
    return this;
  }

  public restAsFixedBlockList<FixedBlocks extends BlocksFixedAny>(
    blocks: FixedBlocks,
  ): FixedBlockList<FixedBlocks> {
    return new FixedBlockList(this.readRest(), blocks, this.dirtyManager);
  }
}

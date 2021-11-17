// deno-lint-ignore-file no-explicit-any
import { DirtyManager } from "./DirtyManager.ts";
import { IBlockFixed } from "./types.d.ts";

export type IBlockNamed<N extends string, Value> = {
  name: N;
  block: IBlockFixed<Value>;
};

export type IBlockNamedAny = IBlockNamed<string, any>;

export type IBlocksFixedAny = ReadonlyArray<IBlockNamedAny>;

export type IBlockNames<Schema extends IBlocksFixedAny> =
  Schema[number]["name"];

export type IBlockValueByName<
  Schema extends IBlocksFixedAny,
  Name extends Schema[number]["name"],
> = Extract<Schema[number], { name: Name }> extends IBlockNamed<string, infer V>
  ? V
  : never;

export type IFixedBlockListItem = { offset: number; block: IBlockFixed<any> };

export class FixedBlockList<FixedBlocks extends IBlocksFixedAny> {
  public static named<N extends string, Value>(
    name: N,
    block: IBlockFixed<Value>,
  ): IBlockNamed<N, Value> {
    return { name, block };
  }

  public readonly schema: FixedBlocks;

  private readonly buffer: Uint8Array;
  private readonly byName = new Map<string, IFixedBlockListItem>();
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

  public read<N extends IBlockNames<FixedBlocks>>(
    name: N,
  ): IBlockValueByName<FixedBlocks, N> {
    const obj = this.byName.get(name);
    if (!obj) {
      throw new Error(`Invalid name "${name}"`);
    }
    const value = obj.block.read.read(this.buffer, obj.offset);
    return value;
  }

  public write<N extends IBlockNames<FixedBlocks>>(
    name: N,
    value: IBlockValueByName<FixedBlocks, N>,
  ): this {
    const obj = this.byName.get(name);
    if (!obj) {
      throw new Error(`Invalid name "${name}"`);
    }
    obj.block.write.write(this.buffer, obj.offset, value);
    this.dirtyManager.markDirty();
    return this;
  }

  public readRest(start?: number, length?: number): Uint8Array {
    const startOffset = this.restOffset + (start ?? 0);
    const endOffset = startOffset + (length ?? this.restLength);
    if (endOffset > this.buffer.byteLength) {
      throw new Error(`Out of range read`);
    }
    return this.buffer.subarray(startOffset, endOffset);
  }

  public writeRest(content: Uint8Array, start?: number): this {
    const startOffset = this.restOffset + (start ?? 0);
    const endOffset = startOffset + content.byteLength;
    if (endOffset > this.buffer.byteLength) {
      throw new Error(`Out of range write`);
    }
    this.buffer.set(content, startOffset);
    this.dirtyManager.markDirty();
    return this;
  }

  public restAsFixedBlockList<FixedBlocks extends IBlocksFixedAny>(
    blocks: FixedBlocks,
  ): FixedBlockList<FixedBlocks> {
    return new FixedBlockList(this.readRest(), blocks, this.dirtyManager);
  }
}

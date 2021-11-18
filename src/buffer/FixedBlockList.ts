// deno-lint-ignore-file no-explicit-any
import { IBufferFacade } from "./BufferFacade.ts";
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
  public readonly restOffset: number;

  private readonly byName = new Map<string, IFixedBlockListItem>();
  private readonly facade: IBufferFacade;

  constructor(
    schema: FixedBlocks,
    facade: IBufferFacade,
  ) {
    this.schema = schema;
    this.facade = facade;
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
    this.restOffset = offset;
  }

  public get fixedLength() {
    return this.restOffset;
  }

  public get restLength() {
    return this.facade.byteLength - this.restOffset;
  }

  public read<N extends IBlockNames<FixedBlocks>>(
    name: N,
  ): IBlockValueByName<FixedBlocks, N> {
    const obj = this.byName.get(name);
    if (!obj) {
      throw new Error(`Invalid name "${name}"`);
    }
    const value = obj.block.read.read(this.facade, obj.offset);
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
    obj.block.write.write(this.facade, obj.offset, value);
    return this;
  }

  public readRest(
    start?: number,
    length?: number,
  ): Uint8Array {
    const startOffset = this.restOffset + (start ?? 0);
    return this.facade.read(startOffset, length);
  }

  public writeRest(
    content: Uint8Array,
    start?: number,
  ): this {
    const startOffset = this.restOffset + (start ?? 0);
    this.facade.write(content, startOffset);
    return this;
  }

  public selectRest(
    start?: number,
    length?: number,
  ): IBufferFacade {
    const startOffset = this.restOffset + (start ?? 0);
    return this.facade.select(startOffset, length);
  }
}

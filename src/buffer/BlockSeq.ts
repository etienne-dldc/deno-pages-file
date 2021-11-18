import { IBufferFacade } from "./BufferFacade.ts";
import { ReadBlock } from "./ReadBlock.ts";
import { IReadBlock, IWriteBlock } from "./types.d.ts";
import { WriteBlock } from "./WriteBlock.ts";

export class BlockSeq {
  protected facade: IBufferFacade;
  protected positionInternal = 0;

  constructor(facade: IBufferFacade, initialPosition = 0) {
    this.facade = facade;
    this.seek(initialPosition);
  }

  public get position() {
    return this.positionInternal;
  }

  public seek(position: number): this {
    if (this.positionInternal === position) {
      return this;
    }
    if (position < 0) {
      throw new Error(`Inavlid position: cannot be negative`);
    }
    // Note we don't check overflox here because facade can be dynamic
    // If position is oveflowing it will wail when write is called
    this.positionInternal = position;
    return this;
  }

  public read<Value>(block: IReadBlock<Value>): Value {
    const readLenth = ReadBlock.resolveSize(block, this.facade, this.position);
    const endPos = this.position + readLenth;
    if (this.isValidPosition(endPos) === false) {
      throw new Error(
        `Cannot read size ${readLenth} at position ${this.position}`,
      );
    }
    const value = block.read(this.facade, this.position);
    this.positionInternal = endPos;
    return value;
  }

  public write<Value>(block: IWriteBlock<Value>, value: Value): this {
    const writeLenth = WriteBlock.resolveSize(block, value);
    const endPos = this.position + writeLenth;
    block.write(this.facade, this.position, value);
    this.positionInternal = endPos;
    return this;
  }

  public isValidPosition(position: number): boolean {
    if (position < 0) {
      return false;
    }
    if (position >= this.facade.byteLength) {
      return false;
    }
    return true;
  }
}

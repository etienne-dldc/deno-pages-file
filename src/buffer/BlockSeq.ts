import { ReadBlock } from "./ReadBlock.ts";
import { IReadBlock, IWriteBlock } from "./types.d.ts";
import { WriteBlock } from "./WriteBlock.ts";

export class BlockSeq {
  protected readonly dynamic: boolean;
  protected buffer: Uint8Array;
  protected positionInternal = 0;

  constructor(
    init?: number | Uint8Array,
    {
      dynamic,
      initialPosition = 0,
    }: { dynamic?: boolean; initialPosition?: number } = {},
  ) {
    const resolved = ((): { buffer: Uint8Array; dynamic: boolean } => {
      if (init === undefined) {
        if (!dynamic) {
          return { buffer: new Uint8Array(512), dynamic: false };
        }
        return { buffer: new Uint8Array(32), dynamic: true };
      }
      if (typeof init === "number") {
        return { buffer: new Uint8Array(init), dynamic: Boolean(dynamic) };
      }
      return { buffer: init, dynamic: Boolean(dynamic) };
    })();
    this.buffer = resolved.buffer;
    this.dynamic = resolved.dynamic;
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
    if (position < this.buffer.byteLength) {
      this.positionInternal = position;
      return this;
    }
    if (!this.dynamic) {
      throw new Error(`Inavlid position: out of range`);
    }
    this.expand(position + 1);
    this.positionInternal = position;
    return this;
  }

  /**
   * Expand the buffer to be at least size (size is always a power of 2)
   */
  public expand(minsize: number): this {
    if (!this.dynamic) {
      throw new Error(`Invalid position: out of range`);
    }
    let newsize = this.buffer.byteLength * 4;
    while (minsize > newsize) {
      newsize *= 4;
    }
    const newBuffer = new Uint8Array(newsize);
    newBuffer.set(this.buffer);
    this.buffer = newBuffer;
    return this;
  }

  public read<Value>(block: IReadBlock<Value>): Value {
    const readLenth = ReadBlock.resolveSize(block, this.buffer, this.position);
    const endPos = this.position + readLenth;
    if (this.isValidPosition(endPos) === false) {
      throw new Error(
        `Cannot read size ${readLenth} at position ${this.position}`,
      );
    }
    const value = block.read(this.buffer, this.position);
    this.positionInternal = endPos;
    return value;
  }

  public write<Value>(block: IWriteBlock<Value>, value: Value): this {
    const writeLenth = WriteBlock.resolveSize(block, value);
    const endPos = this.position + writeLenth;
    this.expand(endPos);
    block.write(this.buffer, this.position, value);
    this.positionInternal = endPos;
    return this;
  }

  public isValidPosition(position: number): boolean {
    if (position < 0) {
      return false;
    }
    if (position >= this.buffer.byteLength) {
      return false;
    }
    return true;
  }
}

// deno-lint-ignore-file no-explicit-any
import { DirtyManager } from "./DirtyManager.ts";

export type BlockNamed<N extends string, Value> = {
  name: N;
  block: BlockFixed<Value>;
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

export type FixedBlockListItem = { offset: number; block: BlockFixed<any> };

export type ReadBlockFixed<Value> = {
  readonly size: number;
  readonly read: (buffer: Uint8Array, offset: number) => Value;
};

export type ReadBlockVariable<Value> = {
  readonly size: (buffer: Uint8Array, offset: number) => number;
  readonly read: (buffer: Uint8Array, offset: number) => Value;
};

export type ReadBlock<Value> =
  | ReadBlockFixed<Value>
  | ReadBlockVariable<Value>;

export type BlockFixed<Value> = {
  read: ReadBlockFixed<Value>;
  write: WriteBlockFixed<Value>;
};

export type Block<Value> = {
  read: ReadBlock<Value>;
  write: WriteBlock<Value>;
};

export type WriteBlockFixed<Value> = {
  readonly size: number;
  readonly write: (buffer: Uint8Array, offset: number, value: Value) => void;
};

export type WriteBlockVariable<Value> = {
  readonly size: (value: Value) => number;
  readonly write: (buffer: Uint8Array, offset: number, value: Value) => void;
};

export type WriteBlock<Value> =
  | WriteBlockFixed<Value>
  | WriteBlockVariable<Value>;

export class FixedBlockList<FixedBlocks extends BlocksFixedAny> {
  public static named<N extends string, Value>(
    name: N,
    block: BlockFixed<Value>,
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

export class BufferBlockSeq {
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

  public read<Value>(block: ReadBlock<Value>): Value {
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

  public write<Value>(block: WriteBlock<Value>, value: Value): this {
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

export const ReadBlock = (() => {
  const tmpbuf = new ArrayBuffer(8);
  const f64arr = new Float64Array(tmpbuf);
  const u8arr = new Uint8Array(tmpbuf);

  const decoder = new TextDecoder();

  const float64: ReadBlockFixed<number> = {
    size: 8,
    read(buf, pos) {
      for (let i = 0; i < 8; i++) {
        u8arr[i] = buf[pos + i];
      }
      return f64arr[0];
    },
  };

  const uint32: ReadBlockFixed<number> = {
    size: 4,
    read(buf, pos) {
      return (
        ((buf[pos] << 24) |
          (buf[pos + 1] << 16) |
          (buf[pos + 2] << 8) |
          buf[pos + 3]) >>>
        0
      );
    },
  };

  const uint16: ReadBlockFixed<number> = {
    size: 2,
    read: (buf, pos) => (buf[pos] << 8) | buf[pos + 1],
  };

  const uint8: ReadBlockFixed<number> = {
    size: 1,
    read: (buf, pos) => buf[pos],
  };

  function bufferFixed(len: number): ReadBlockFixed<Uint8Array> {
    return {
      size: len,
      read: (buf, pos) => buf.slice(pos, pos + len),
    };
  }

  const encodedUint: ReadBlockVariable<number> = {
    size(buf, pos) {
      const val = uint8.read(buf, pos);
      return val < 254
        ? uint8.size
        : uint8.size + (val == 254 ? uint16.size : uint32.size);
    },
    read(buf, pos) {
      const val = uint8.read(buf, pos);
      if (val < 254) {
        return val;
      }
      if (val == 254) {
        return uint16.read(buf, pos + uint8.size);
      }
      return uint32.read(buf, pos + uint8.size);
    },
  };

  function fixedString(length: number): ReadBlockFixed<string> {
    return {
      size: length,
      read: (buf, pos) => {
        return decoder.decode(
          buf.subarray(pos, pos + length),
        );
      },
    };
  }

  const encodedString: ReadBlockVariable<string> = {
    size(buf, pos) {
      const len = encodedUint.read(buf, pos);
      const sizeLen = encodedUint.size(buf, pos);
      return sizeLen + len;
    },
    read: (buf, pos) => {
      const len = encodedUint.read(buf, pos);
      const sizeLen = encodedUint.size(buf, pos);
      const str = decoder.decode(
        buf.subarray(pos + sizeLen, pos + sizeLen + len),
      );
      return str;
    },
  };

  // deno-fmt-ignore
  function seq<V1>(b1: ReadBlock<V1>): ReadBlockVariable<[V1]>;
  // deno-fmt-ignore
  function seq<V1, V2>(b1: ReadBlock<V1>, b2: ReadBlock<V2>): ReadBlockVariable<[V1, V2]>;
  // deno-fmt-ignore
  function seq<V1, V2, V3>(b1: ReadBlock<V1>, b2: ReadBlock<V2>, b3: ReadBlock<V3>): ReadBlockVariable<[V1, V2, V3]>;
  // deno-fmt-ignore
  function seq<V1, V2, V3, V4>(b1: ReadBlock<V1>, b2: ReadBlock<V2>, b3: ReadBlock<V3>, b4: ReadBlock<V4>): ReadBlockVariable<[V1, V2, V3, V4]>;
  // deno-fmt-ignore
  function seq<V1, V2, V3, V4, V5>(b1: ReadBlock<V1>, b2: ReadBlock<V2>, b3: ReadBlock<V3>, b4: ReadBlock<V4>, b5: ReadBlock<V5>): ReadBlockVariable<[V1, V2, V3, V4, V5]>;
  // deno-fmt-ignore
  function seq(...items: Array<ReadBlock<any>>): ReadBlockVariable<Array<any>>;
  function seq(...items: Array<ReadBlock<any>>): ReadBlockVariable<any> {
    return {
      size(buf, pos) {
        let size = 0;
        let offset = pos;
        items.forEach((item) => {
          const len = resolveSize(item, buf, offset);
          size += len;
          offset += len;
        });
        return size;
      },
      read(buf, pos) {
        let offset = pos;
        const result: Array<any> = [];
        items.forEach((item) => {
          const size = resolveSize(item, buf, offset);
          result.push(item.read(buf, offset));
          offset += size;
        });
        return result;
      },
    };
  }

  function transform<Inner, Outer>(
    block: ReadBlock<Inner>,
    transform: (val: Inner) => Outer,
  ): ReadBlock<Outer> {
    const size = block.size;
    if (typeof size === "number") {
      return {
        size: size,
        read: (buf, pos) => transform(block.read(buf, pos)),
      };
    }
    return {
      size: (buf, pos) => size(buf, pos),
      read: (buf, pos) => transform(block.read(buf, pos)),
    };
  }

  function resolveSize(
    block: ReadBlock<any>,
    buffer: Uint8Array,
    offset: number,
  ): number {
    return typeof block.size === "number"
      ? block.size
      : block.size(buffer, offset);
  }

  function dynamic<Value>(
    getBlock: (buf: Uint8Array, pos: number) => ReadBlock<Value>,
  ): ReadBlock<Value> {
    return {
      size: (buf, pos) => resolveSize(getBlock(buf, pos), buf, pos),
      read: (buf, pos) => getBlock(buf, pos).read(buf, pos),
    };
  }

  function inject<Value>(
    block: ReadBlock<Value>,
    value: Value,
  ): ReadBlock<void> {
    const size = block.size;
    if (typeof size === "number") {
      return {
        size,
        read: () => value,
      };
    }
    return {
      size: (buf, pos) => size(buf, pos),
      read: () => value,
    };
  }

  function withHeader<Header, Value>(
    headerBlock: ReadBlock<Header>,
    getBlock: (header: Header) => ReadBlock<Value>,
  ): ReadBlock<Value> {
    return {
      size: (buf, pos) => {
        const header = headerBlock.read(buf, pos);
        const headerSize = resolveSize(headerBlock, buf, pos);
        return headerSize +
          resolveSize(getBlock(header), buf, pos + headerSize);
      },
      read: (buf, pos) => {
        const header = headerBlock.read(buf, pos);
        const headerSize = resolveSize(headerBlock, buf, pos);
        return getBlock(header).read(buf, pos + headerSize);
      },
    };
  }

  function repeat<Value>(
    count: number,
    block: ReadBlock<Value>,
  ): ReadBlock<Array<Value>> {
    return {
      size: (buf, pos) => {
        let size = 0;
        let offset = pos;
        for (let i = 0; i < count; i++) {
          const len = resolveSize(block, buf, offset);
          offset += len;
          size += len;
        }
        return size;
      },
      read: (buf, pos) => {
        let offset = pos;
        const result: Array<Value> = [];
        for (let i = 0; i < count; i++) {
          const element = block.read(buf, offset);
          result.push(element);
          const size = resolveSize(block, buf, offset);
          offset += size;
        }
        return result;
      },
    };
  }

  return {
    float64,
    uint32,
    uint16,
    uint8,
    encodedUint,
    encodedString,
    fixedString,
    bufferFixed,
    // utils
    seq,
    inject,
    transform,
    dynamic,
    repeat,
    resolveSize,
    withHeader,
  };
})();

export const WriteBlock = (() => {
  const tmpbuf = new ArrayBuffer(8);
  const f64arr = new Float64Array(tmpbuf);
  const u8arr = new Uint8Array(tmpbuf);

  const encoder = new TextEncoder();

  const float64: WriteBlock<number> = {
    size: 8,
    write(buf, pos, val) {
      f64arr[0] = val;
      buf.set(u8arr, pos);
    },
  };

  const uint32: WriteBlock<number> = {
    size: 4,
    write(buf, pos, val) {
      buf[pos] = (val >>> 24) & 0xff;
      buf[pos + 1] = (val >>> 16) & 0xff;
      buf[pos + 2] = (val >>> 8) & 0xff;
      buf[pos + 3] = val & 0xff;
    },
  };

  const uint16: WriteBlock<number> = {
    size: 2,
    write(buf, pos, val) {
      buf[pos] = (val >> 8) & 0xff;
      buf[pos + 1] = val & 0xff;
    },
  };

  const uint8: WriteBlock<number> = {
    size: 1,
    write: (buf, pos, val) => buf[pos] = val & 0xff,
  };

  const buffer: WriteBlockVariable<Uint8Array> = {
    size: (val) => val.byteLength,
    write: (buf, pos, val) => buf.set(val, pos),
  };

  const string: WriteBlockVariable<string> = {
    size: (val) => calcStringSize(val),
    write: (buf, pos, val) => encoder.encodeInto(val, buf.subarray(pos)),
  };

  function bufferFixed(len: number): WriteBlock<Uint8Array> {
    return {
      size: len,
      write(buf, pos, val) {
        buf.set(val, pos);
      },
    };
  }

  const encodedUintSize = (val: number) => {
    return val < 254
      ? uint8.size
      : uint8.size + (val < 65536 ? uint16.size : uint32.size);
  };

  const encodedUint: WriteBlockVariable<number> = {
    size: (val) => encodedUintSize(val),
    write(buf, pos, val) {
      if (val < 254) {
        uint8.write(buf, pos, val);
        return;
      }
      if (val < 65536) {
        uint8.write(buf, pos, 254);
        uint16.write(buf, pos + uint8.size, val);
        return;
      }
      uint8.write(buf, pos, 255);
      uint32.write(buf, pos + uint8.size, val);
    },
  };

  const encodedString: WriteBlockVariable<string> = {
    size(val) {
      const len = calcStringSize(val);
      const sizeLen = encodedUint.size(len);
      return sizeLen + len;
    },
    write: (buf, pos, val) => {
      const len = calcStringSize(val);
      const sizeLen = encodedUint.size(len);
      encodedUint.write(buf, pos, len);
      encoder.encodeInto(val, buf.subarray(pos + sizeLen));
    },
  };

  function many<Value>(
    block: WriteBlock<Value>,
  ): WriteBlockVariable<Array<Value>> {
    return {
      size(vals) {
        let size = 0;
        vals.forEach((val) => {
          size += resolveSize(block, val);
        });
        return size;
      },
      write(buf, pos, vals) {
        let offset = pos;
        vals.forEach((val) => {
          const size = resolveSize(block, val);
          block.write(buf, offset, val);
          offset += size;
        });
      },
    };
  }

  // deno-fmt-ignore
  function seq<V1>(b1: WriteBlock<V1>): WriteBlockVariable<[V1]>;
  // deno-fmt-ignore
  function seq<V1, V2>(b1: WriteBlock<V1>, b2: WriteBlock<V2>): WriteBlockVariable<[V1, V2]>;
  // deno-fmt-ignore
  function seq<V1, V2, V3>(b1: WriteBlock<V1>, b2: WriteBlock<V2>, b3: WriteBlock<V3>): WriteBlockVariable<[V1, V2, V3]>;
  // deno-fmt-ignore
  function seq<V1, V2, V3, V4>(b1: WriteBlock<V1>, b2: WriteBlock<V2>, b3: WriteBlock<V3>, b4: WriteBlock<V4>): WriteBlockVariable<[V1, V2, V3, V4]>;
  // deno-fmt-ignore
  function seq<V1, V2, V3, V4, V5>(b1: WriteBlock<V1>, b2: WriteBlock<V2>, b3: WriteBlock<V3>, b4: WriteBlock<V4>, b5: WriteBlock<V5>): WriteBlockVariable<[V1, V2, V3, V4, V5]>;
  // deno-fmt-ignore
  function seq(...items: Array<WriteBlock<any>>): WriteBlockVariable<Array<any>>;
  function seq(...items: Array<WriteBlock<any>>): WriteBlockVariable<any> {
    return {
      size(val) {
        if (val.length !== items.length) {
          throw new Error("Invalid seq array length");
        }
        let size = 0;
        items.forEach((item, index) => {
          size += resolveSize(item, val[index]);
        });
        return size;
      },
      write(buf, pos, val) {
        if (val.length !== items.length) {
          throw new Error("Invalid seq array length");
        }
        let offset = pos;
        items.forEach((item, index) => {
          const size = resolveSize(item, val[index]);
          item.write(buf, offset, val[index]);
          offset += size;
        });
      },
    };
  }

  function transform<Inner, Outer>(
    block: WriteBlock<Inner>,
    transform: (val: Outer) => Inner,
  ): WriteBlock<Outer> {
    const size = block.size;
    if (typeof size === "number") {
      return {
        size,
        write: (buf, pos, val) => block.write(buf, pos, transform(val)),
      };
    }
    return {
      size: (val) => size(transform(val)),
      write: (buf, pos, val) => block.write(buf, pos, transform(val)),
    };
  }

  function inject<Value>(
    block: WriteBlock<Value>,
    value: Value,
  ): WriteBlock<void> {
    const size = block.size;
    if (typeof size === "number") {
      return {
        size,
        write: (buf, pos, _val) => block.write(buf, pos, value),
      };
    }
    return {
      size: (_val) => size(value),
      write: (buf, pos, _val) => block.write(buf, pos, value),
    };
  }

  function dynamic<Value>(
    getBlock: (val: Value) => WriteBlock<Value>,
  ): WriteBlock<Value> {
    return {
      size: (val) => resolveSize(getBlock(val), val),
      write: (buf, pos, val) => getBlock(val).write(buf, pos, val),
    };
  }

  function resolveSize<Value>(block: WriteBlock<Value>, value: Value): number {
    return typeof block.size === "number" ? block.size : block.size(value);
  }

  return {
    float64,
    uint32,
    uint16,
    uint8,
    encodedUint,
    encodedString,
    string,
    buffer,
    bufferFixed,
    // utils
    seq,
    transform,
    inject,
    many,
    dynamic,
    resolveSize,
  };
})();

export const Block = {
  uint8: { read: ReadBlock.uint8, write: WriteBlock.uint8 },
  uint16: { read: ReadBlock.uint16, write: WriteBlock.uint16 },
  uint32: { read: ReadBlock.uint32, write: WriteBlock.uint32 },
  float64: { read: ReadBlock.float64, write: WriteBlock.float64 },
  encodedUint: { read: ReadBlock.encodedUint, write: WriteBlock.encodedUint },
  encodedString: {
    read: ReadBlock.encodedString,
    write: WriteBlock.encodedString,
  },
} as const;

export function calcStringSize(str: string): number {
  let bytes = 0;
  const len = str.length;
  for (let i = 0; i < len; i++) {
    const codePoint = str.charCodeAt(i);
    if (codePoint < 0x80) {
      bytes += 1;
    } else if (codePoint < 0x800) {
      bytes += 2;
    } else if (codePoint >= 0xd800 && codePoint < 0xe000) {
      if (codePoint < 0xdc00 && i + 1 < len) {
        const next = str.charCodeAt(i + 1);
        if (next >= 0xdc00 && next < 0xe000) {
          bytes += 4;
          i++;
        } else {
          bytes += 3;
        }
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

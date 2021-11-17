// deno-lint-ignore-file no-explicit-any
import { IReadBlock, IReadBlockFixed, IReadBlockVariable } from "./types.d.ts";

export const ReadBlock = (() => {
  const tmpbuf = new ArrayBuffer(8);
  const f64arr = new Float64Array(tmpbuf);
  const u8arr = new Uint8Array(tmpbuf);

  const decoder = new TextDecoder();

  const float64: IReadBlockFixed<number> = {
    size: 8,
    read(buf, pos) {
      for (let i = 0; i < 8; i++) {
        u8arr[i] = buf[pos + i];
      }
      return f64arr[0];
    },
  };

  const uint32: IReadBlockFixed<number> = {
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

  const uint16: IReadBlockFixed<number> = {
    size: 2,
    read: (buf, pos) => (buf[pos] << 8) | buf[pos + 1],
  };

  const uint8: IReadBlockFixed<number> = {
    size: 1,
    read: (buf, pos) => buf[pos],
  };

  function bufferFixed(len: number): IReadBlockFixed<Uint8Array> {
    return {
      size: len,
      read: (buf, pos) => buf.slice(pos, pos + len),
    };
  }

  const encodedUint: IReadBlockVariable<number> = {
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

  function fixedString(length: number): IReadBlockFixed<string> {
    return {
      size: length,
      read: (buf, pos) => {
        return decoder.decode(
          buf.subarray(pos, pos + length),
        );
      },
    };
  }

  const encodedString: IReadBlockVariable<string> = {
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
  function seq<V1>(b1: IReadBlock<V1>): IReadBlockVariable<[V1]>;
  // deno-fmt-ignore
  function seq<V1, V2>(b1: IReadBlock<V1>, b2: IReadBlock<V2>): IReadBlockVariable<[V1, V2]>;
  // deno-fmt-ignore
  function seq<V1, V2, V3>(b1: IReadBlock<V1>, b2: IReadBlock<V2>, b3: IReadBlock<V3>): IReadBlockVariable<[V1, V2, V3]>;
  // deno-fmt-ignore
  function seq<V1, V2, V3, V4>(b1: IReadBlock<V1>, b2: IReadBlock<V2>, b3: IReadBlock<V3>, b4: IReadBlock<V4>): IReadBlockVariable<[V1, V2, V3, V4]>;
  // deno-fmt-ignore
  function seq<V1, V2, V3, V4, V5>(b1: IReadBlock<V1>, b2: IReadBlock<V2>, b3: IReadBlock<V3>, b4: IReadBlock<V4>, b5: IReadBlock<V5>): IReadBlockVariable<[V1, V2, V3, V4, V5]>;
  // deno-fmt-ignore
  function seq(...items: Array<IReadBlock<any>>): IReadBlockVariable<Array<any>>;
  function seq(...items: Array<IReadBlock<any>>): IReadBlockVariable<any> {
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
    block: IReadBlock<Inner>,
    transform: (val: Inner) => Outer,
  ): IReadBlock<Outer> {
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
    block: IReadBlock<any>,
    buffer: Uint8Array,
    offset: number,
  ): number {
    return typeof block.size === "number"
      ? block.size
      : block.size(buffer, offset);
  }

  function dynamic<Value>(
    getBlock: (buf: Uint8Array, pos: number) => IReadBlock<Value>,
  ): IReadBlock<Value> {
    return {
      size: (buf, pos) => resolveSize(getBlock(buf, pos), buf, pos),
      read: (buf, pos) => getBlock(buf, pos).read(buf, pos),
    };
  }

  function inject<Value>(
    block: IReadBlock<Value>,
    value: Value,
  ): IReadBlock<void> {
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
    headerBlock: IReadBlock<Header>,
    getBlock: (header: Header) => IReadBlock<Value>,
  ): IReadBlock<Value> {
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
    block: IReadBlock<Value>,
  ): IReadBlock<Array<Value>> {
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

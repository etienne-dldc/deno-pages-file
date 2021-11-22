// deno-lint-ignore-file no-explicit-any
import {
  IWriteBlock,
  IWriteBlockFixed,
  IWriteBlockVariable,
} from "./types.d.ts";
import { calcStringSize } from "./utils.ts";

export const WriteBlock = (() => {
  const tmpbuf = new ArrayBuffer(8);
  const f64arr = new Float64Array(tmpbuf);
  const u8arr = new Uint8Array(tmpbuf);

  const encoder = new TextEncoder();

  const float64: IWriteBlock<number> = {
    size: 8,
    write(buf, pos, val) {
      f64arr[0] = val;
      buf.write(u8arr, pos);
    },
  };

  const uint32: IWriteBlockFixed<number> = {
    size: 4,
    write(buf, pos, val) {
      buf.writeByte(pos, (val >>> 24) & 0xff);
      buf.writeByte(pos + 1, (val >>> 16) & 0xff);
      buf.writeByte(pos + 2, (val >>> 8) & 0xff);
      buf.writeByte(pos + 3, val & 0xff);
    },
  };

  const uint16: IWriteBlockFixed<number> = {
    size: 2,
    write(buf, pos, val) {
      buf.writeByte(pos, (val >> 8) & 0xff);
      buf.writeByte(pos + 1, val & 0xff);
    },
  };

  const uint8: IWriteBlockFixed<number> = {
    size: 1,
    write: (buf, pos, val) => {
      buf.writeByte(pos, val & 0xff);
    },
  };

  const buffer: IWriteBlockVariable<Uint8Array> = {
    size: (val) => val.byteLength,
    write: (buf, pos, val) => buf.write(val, pos),
  };

  const string: IWriteBlockVariable<string> = {
    size: (val) => calcStringSize(val),
    write: (buf, pos, val) => {
      buf.write(encoder.encode(val), pos);
    },
  };

  function arrayOf<T>(itemBlock: IWriteBlock<T>): IWriteBlock<Array<T>> {
    return transform(
      seq(uint16, many(itemBlock)),
      (arr): [number, Array<T>] => [arr.length, arr],
    );
  }

  function bufferFixed(len: number): IWriteBlockFixed<Uint8Array> {
    return {
      size: len,
      write(buf, pos, val) {
        buf.write(val, pos);
      },
    };
  }

  const encodedBoolean: IWriteBlockFixed<boolean> = transformFixed(
    uint8,
    (val) => Number(val),
  );

  const encodedUintSize = (val: number) => {
    return val < 254
      ? uint8.size
      : uint8.size + (val < 65536 ? uint16.size : uint32.size);
  };

  const encodedUint: IWriteBlockVariable<number> = {
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

  const encodedString: IWriteBlockVariable<string> = {
    size(val) {
      const len = calcStringSize(val);
      const sizeLen = encodedUint.size(len);
      return sizeLen + len;
    },
    write: (buf, pos, val) => {
      const len = calcStringSize(val);
      const sizeLen = encodedUint.size(len);
      encodedUint.write(buf, pos, len);
      buf.write(encoder.encode(val), pos + sizeLen);
    },
  };

  function many<Value>(
    block: IWriteBlock<Value>,
  ): IWriteBlockVariable<Array<Value>> {
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
  function seq<V1>(b1: IWriteBlock<V1>): IWriteBlockVariable<[V1]>;
  // deno-fmt-ignore
  function seq<V1, V2>(b1: IWriteBlock<V1>, b2: IWriteBlock<V2>): IWriteBlockVariable<[V1, V2]>;
  // deno-fmt-ignore
  function seq<V1, V2, V3>(b1: IWriteBlock<V1>, b2: IWriteBlock<V2>, b3: IWriteBlock<V3>): IWriteBlockVariable<[V1, V2, V3]>;
  // deno-fmt-ignore
  function seq<V1, V2, V3, V4>(b1: IWriteBlock<V1>, b2: IWriteBlock<V2>, b3: IWriteBlock<V3>, b4: IWriteBlock<V4>): IWriteBlockVariable<[V1, V2, V3, V4]>;
  // deno-fmt-ignore
  function seq<V1, V2, V3, V4, V5>(b1: IWriteBlock<V1>, b2: IWriteBlock<V2>, b3: IWriteBlock<V3>, b4: IWriteBlock<V4>, b5: IWriteBlock<V5>): IWriteBlockVariable<[V1, V2, V3, V4, V5]>;
  // deno-fmt-ignore
  function seq(...items: Array<IWriteBlock<any>>): IWriteBlockVariable<Array<any>>;
  function seq(...items: Array<IWriteBlock<any>>): IWriteBlockVariable<any> {
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

  function transformFixed<Inner, Outer>(
    block: IWriteBlockFixed<Inner>,
    transform: (val: Outer) => Inner,
  ): IWriteBlockFixed<Outer> {
    const size = block.size;
    return {
      size,
      write: (buf, pos, val) => block.write(buf, pos, transform(val)),
    };
  }

  function transform<Inner, Outer>(
    block: IWriteBlock<Inner>,
    transform: (val: Outer) => Inner,
  ): IWriteBlock<Outer> {
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
    block: IWriteBlock<Value>,
    value: Value,
  ): IWriteBlock<void> {
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
    getBlock: (val: Value) => IWriteBlock<Value>,
  ): IWriteBlock<Value> {
    return {
      size: (val) => resolveSize(getBlock(val), val),
      write: (buf, pos, val) => getBlock(val).write(buf, pos, val),
    };
  }

  function resolveSize<Value>(block: IWriteBlock<Value>, value: Value): number {
    return typeof block.size === "number" ? block.size : block.size(value);
  }

  return {
    float64,
    uint32,
    uint16,
    uint8,
    encodedUint,
    encodedString,
    encodedBoolean,
    string,
    buffer,
    arrayOf,
    bufferFixed,
    // utils
    seq,
    transform,
    transformFixed,
    inject,
    many,
    dynamic,
    resolveSize,
  };
})();

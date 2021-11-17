// deno-lint-ignore-file no-explicit-any
import { ReadBlock as R } from "./ReadBlock.ts";
import { IReadBlock, IWriteBlock } from "./types.d.ts";
import { calcStringSize } from "./utils.ts";
import { WriteBlock as W } from "./WriteBlock.ts";

const enum Type {
  Null = 0,
  Undefined,
  False,
  True,
  Uint8,
  Uint16,
  Uint32,
  NegUint8,
  NegUint16,
  NegUint32,
  Float64,
  String,
  Binary,
  Object,
  Array,
  // 15 ~ 35 not used
  Array0 = 36,
  Object0 = 45,
  Binary0 = 54,
  String0 = 87,
  NumberNeg0 = 127,
  Number0 = 128,
}

export const BinvalReadBlock = (() => {
  const decodeMap: Array<IReadBlock<any> | null> = [];

  decodeMap[Type.Null] = R.transform(R.uint8, () => null);
  decodeMap[Type.Undefined] = R.transform(R.uint8, () => undefined);
  decodeMap[Type.False] = R.transform(R.uint8, () => false);
  decodeMap[Type.True] = R.transform(R.uint8, () => true);
  decodeMap[Type.Uint8] = R.transform(
    R.seq(R.uint8, R.uint8),
    ([_type, val]) => val,
  );
  decodeMap[Type.Uint16] = R.transform(
    R.seq(R.uint8, R.uint16),
    ([_type, val]) => val,
  );
  decodeMap[Type.Uint32] = R.transform(
    R.seq(R.uint8, R.uint32),
    ([_type, val]) => val,
  );
  decodeMap[Type.NegUint8] = R.transform(
    R.seq(R.uint8, R.uint8),
    ([_type, val]) => -val,
  );
  decodeMap[Type.NegUint16] = R.transform(
    R.seq(R.uint8, R.uint16),
    ([_type, val]) => -val,
  );
  decodeMap[Type.NegUint32] = R.transform(
    R.seq(R.uint8, R.uint32),
    ([_type, val]) => -val,
  );
  decodeMap[Type.Float64] = R.transform(
    R.seq(R.uint8, R.float64),
    ([_type, val]) => val,
  );
  decodeMap[Type.String] = R.transform(
    R.seq(R.uint8, R.encodedString),
    ([_type, val]) => val,
  );
  decodeMap[Type.Binary] = R.withHeader(
    R.seq(R.uint8, R.encodedUint),
    ([_type, len]) => R.bufferFixed(len),
  );
  decodeMap[Type.Object] = R.withHeader(
    R.seq(R.uint8, R.encodedUint),
    ([_type, len]) => {
      return R.transform(
        R.repeat(len, R.seq(R.encodedString, value)),
        (entries) => Object.fromEntries(entries),
      );
    },
  );
  decodeMap[Type.Array] = R.withHeader(
    R.seq(R.uint8, R.encodedUint),
    ([_type, len]) => R.repeat(len, value),
  );
  // Compact versions
  const smallArray = R.withHeader(
    R.uint8,
    (type) => {
      return R.repeat(type - Type.Array0, value);
    },
  );
  for (let i = 0; i <= 8; i++) {
    decodeMap[Type.Array0 + i] = smallArray;
  }
  const smallObject = R.withHeader(
    R.uint8,
    (type) =>
      R.transform(
        R.repeat(
          type - Type.Object0,
          R.seq(R.encodedString, value),
        ),
        (entries) => Object.fromEntries(entries),
      ),
  );
  for (let i = 0; i <= 8; i++) {
    decodeMap[Type.Object0 + i] = smallObject;
  }
  const smallBinary = R.withHeader(
    R.uint8,
    (type) => R.bufferFixed(type - Type.Binary0),
  );
  for (let i = 0; i <= 32; i++) {
    decodeMap[Type.Binary0 + i] = smallBinary;
  }
  decodeMap[Type.String0] = R.transform(R.uint8, () => "");
  const smallString = R.withHeader(
    R.uint8,
    (type) => R.fixedString(type - Type.String0),
  );
  for (let i = 1; i <= 32; i++) {
    decodeMap[Type.String0 + i] = smallString;
  }
  const smallNegativeNumber = R.transform(
    R.uint8,
    (type) => type - Type.NumberNeg0,
  );
  for (let i = 120; i <= 126; i++) {
    decodeMap[Type.NumberNeg0 + (i - 120)] = smallNegativeNumber;
  }
  decodeMap[Type.Number0] = R.transform(R.uint8, () => -0);
  const smallPositiveNumber = R.transform(
    R.uint8,
    (type) => type - Type.Number0,
  );
  for (let i = 128; i <= 255; i++) {
    decodeMap[Type.Number0 + (i - 128)] = smallPositiveNumber;
  }

  const value: IReadBlock<any> = R.dynamic((buf, pos) => {
    const type = R.uint8.read(buf, pos);
    const block = decodeMap[type];
    if (!block) {
      throw new Error(`Invalid type: ${type}`);
    }
    return block;
  });

  return {
    value,
  };
})();

export const BinvalWriteBlock = (() => {
  const value: IWriteBlock<any> = W.dynamic((val: any): IWriteBlock<any> => {
    if (val === null) {
      return W.inject(W.uint8, Type.Null);
    }
    if (val === undefined) {
      return W.inject(W.uint8, Type.Undefined);
    }
    if (val === false) {
      return W.inject(W.uint8, Type.False);
    }
    if (val === true) {
      return W.inject(W.uint8, Type.True);
    }
    if (typeof val === "number") {
      return number;
    }
    if (typeof val === "string") {
      return string;
    }
    if (typeof val === "object") {
      if (val instanceof Array) {
        return array;
      }
      if (val instanceof Uint8Array) {
        return uint8Array;
      }
      return object;
    }
    throw new Error("Unsupported value " + val);
  });

  const integer = ((): IWriteBlock<number> => {
    return W.dynamic((val: number) => {
      if (val >= -7 && val <= 127) {
        if (val > 0) {
          return W.transform(W.uint8, (val: number) => Type.Number0 + val);
        }
        if (val < 0) {
          return W.transform(W.uint8, (val: number) => Type.NumberNeg0 + val);
        }
        if (Object.is(val, -0)) {
          return W.transform(W.uint8, () => Type.NumberNeg0);
        }
        return W.transform(W.uint8, () => Type.Number0);
      }
      let negative = 0;
      if (val < 0) {
        val = -val;
        negative = 3;
      }
      if (val < 256) {
        return W.transform<[number, number], number>(
          W.seq(W.uint8, W.uint8),
          () => [Type.Uint8 + negative, val],
        );
      }
      if (val < 65536) {
        return W.transform<[number, number], number>(
          W.seq(W.uint8, W.uint16),
          () => [Type.Uint16 + negative, val],
        );
      }
      if (val < 2 ** 32) {
        return W.transform<[number, number], number>(
          W.seq(W.uint8, W.uint32),
          () => [Type.Uint32 + negative, val],
        );
      }
      // float64
      return W.transform<[number, number], number>(
        W.seq(W.uint8, W.float64),
        () => [Type.Float64, negative ? -val : val],
      );
    });
  })();

  const float = W.transform<[number, number], number>(
    W.seq(W.uint8, W.float64),
    (val) => [Type.Float64, val],
  );

  const number = W.dynamic((val: number) =>
    Number.isInteger(val) ? integer : float
  );

  const smallString = W.transform<[number, string], string>(
    W.seq(W.uint8, W.string),
    (val) => {
      const len = calcStringSize(val);
      return [Type.String0 + len, val];
    },
  );

  const bigString = W.transform<[number, string], string>(
    W.seq(W.uint8, W.encodedString),
    (val) => [Type.String, val],
  );

  const string = ((): IWriteBlock<string> => {
    return W.dynamic((val: string) => {
      const len = calcStringSize(val);
      return len <= 32 ? smallString : bigString;
    });
  })();

  const smallArray = W.transform<[number, Array<any>], Array<any>>(
    W.seq(W.uint8, W.many(value)),
    (arr) => [Type.Array0 + arr.length, arr],
  );

  const bigArray = W.transform<[number, number, Array<any>], Array<any>>(
    W.seq(W.uint8, W.encodedUint, W.many(value)),
    (arr) => [Type.Array, arr.length, arr],
  );

  const array = W.dynamic((arr: Array<any>) => {
    return arr.length <= 8 ? smallArray : bigArray;
  });

  const smallUint8Array = W.transform<[number, Uint8Array], Uint8Array>(
    W.seq(W.uint8, W.buffer),
    (arr) => [Type.Binary0 + arr.byteLength, arr],
  );

  const bigUint8Array = W.transform<[number, number, Uint8Array], Uint8Array>(
    W.seq(W.uint8, W.encodedUint, W.buffer),
    (arr) => [Type.Binary, arr.byteLength, arr],
  );

  const uint8Array = W.dynamic((arr: Uint8Array) => {
    return arr.byteLength <= 32 ? smallUint8Array : bigUint8Array;
  });

  const smallObject = W.transform<
    [number, Array<[string, any]>],
    Record<string, any>
  >(
    W.seq(W.uint8, W.many(W.seq(W.encodedString, value))),
    (obj) => [
      Type.Object0 + Object.keys(obj).length,
      Array.from(Object.entries(obj)),
    ],
  );

  const bigObject = W.transform<
    [number, number, Array<[string, any]>],
    Record<string, any>
  >(
    W.seq(W.uint8, W.encodedUint, W.many(W.seq(W.encodedString, value))),
    (obj) => [
      Type.Object,
      Object.keys(obj).length,
      Array.from(Object.entries(obj)),
    ],
  );

  const object = W.dynamic((obj: Record<string, any>) => {
    const keys = Object.keys(obj);
    return keys.length <= 8 ? smallObject : bigObject;
  });

  return {
    value,
    integer,
    number,
    object,
    array,
  };
})();

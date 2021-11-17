import { assertEquals } from "https://deno.land/std@0.114.0/testing/asserts.ts";
import { BinvalReadBlock, BinvalWriteBlock } from "./Binval.ts";

const values = [
  null,
  undefined,
  true,
  false,
  0,
  "hello",
  {},
  [0, 1, 2, 3, 4, 5, 6, {}, 2],
  [{}, 0, 1, null],
  "some long text blah blah blah blah blah",
  { hey: "salut" },
  { hey: [{}, null] },
  { hey: [{}, null, { a: { b: { c: { d: undefined } } } }] },
];

values.forEach((val, index) => {
  Deno.test(`Write then read value at index ${index}`, () => {
    const buf = new Uint8Array(512);
    BinvalWriteBlock.value.write(buf, 0, val);
    const out = BinvalReadBlock.value.read(buf, 0);
    assertEquals(val, out);
  });
});

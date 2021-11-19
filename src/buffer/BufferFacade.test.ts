import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.114.0/testing/asserts.ts";
import {
  DynamicBufferFacade,
  PagedBufferFacade,
  SimpleBufferFacade,
} from "./BufferFacade.ts";

Deno.test("SimpleBufferFacade", () => {
  const buf = new SimpleBufferFacade(new Uint8Array(10));
  assertEquals(buf.byteLength, 10);
  buf.write(new Uint8Array([99, 99, 99]));
  assertEquals(buf.read(), new Uint8Array([99, 99, 99, 0, 0, 0, 0, 0, 0, 0]));
  buf.write(new Uint8Array([99, 99, 99]), 7);
  assertEquals(
    buf.read(),
    new Uint8Array([99, 99, 99, 0, 0, 0, 0, 99, 99, 99]),
  );
  assertEquals(buf.read(), buf.read(0, 10));
  assertEquals(buf.read(2, 6).byteLength, 6);
  assertEquals(
    buf.read(2, 6),
    new Uint8Array([99, 0, 0, 0, 0, 99]),
  );
  assertThrows(() => buf.read(-1));
  assertThrows(() => buf.read(0, 11));
  assertThrows(() => buf.read(2, 9));
  const selected = buf.select(2, 6);
  assertThrows(() => buf.select(2, 9));
  assertThrows(() => buf.select(-1));
  assertEquals(selected.byteLength, 6);
  assertEquals(
    selected.read(),
    new Uint8Array([99, 0, 0, 0, 0, 99]),
  );
});

Deno.test("DynamicBufferFacade", () => {
  const buf = new DynamicBufferFacade();
  assertEquals(buf.byteLength, 32);
  buf.writeByte(20, 99);
  assertEquals(buf.byteLength, 32);
  buf.writeByte(32, 99);
  assertEquals(buf.byteLength, 128);
  buf.write(new Uint8Array(200));
  assertEquals(buf.byteLength, 512);
});

Deno.test("PagedBufferFacade", () => {
  const selectBuf = new SimpleBufferFacade(new Uint8Array(10));

  const bufs = [
    selectBuf.select(5, 5),
    new SimpleBufferFacade(new Uint8Array(5)),
    new SimpleBufferFacade(new Uint8Array(5)),
  ];

  const buf = new PagedBufferFacade<number>(0, (index) => {
    const b = bufs[index];
    if (!b) {
      return null;
    }
    return { buffer: b, nextPageInfo: index + 1 };
  }, () => {});

  assertEquals(buf.byteLength, 15);
  buf.write(new Uint8Array([9, 9, 9]), 4);
  assertEquals(
    selectBuf.read(),
    new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 9]),
  );
  assertEquals(
    bufs[1].read(),
    new Uint8Array([9, 9, 0, 0, 0]),
  );
  assertEquals(
    buf.read(),
    new Uint8Array([0, 0, 0, 0, 9, 9, 9, 0, 0, 0, 0, 0, 0, 0, 0]),
  );
});

Deno.test("PagedBufferFacade cleanup", () => {
  const bufs = [
    new SimpleBufferFacade(new Uint8Array(5)),
    new SimpleBufferFacade(new Uint8Array(5)),
    new SimpleBufferFacade(new Uint8Array(5)),
  ];

  let deletedPage: Array<number> = [];

  const buf = new PagedBufferFacade<number>(0, (index) => {
    const b = bufs[index];
    if (!b) {
      return null;
    }
    return { buffer: b, nextPageInfo: index + 1 };
  }, (pageIndex) => {
    deletedPage.push(pageIndex);
  });

  buf.cleanupAfter(4);
  assertEquals(deletedPage, [1]);

  deletedPage = [];

  buf.cleanupAfter(5);
  assertEquals(deletedPage, [2]);

  deletedPage = [];

  buf.cleanupAfter(10);
  assertEquals(deletedPage, [3]);

  deletedPage = [];

  buf.cleanupAfter(14);
  assertEquals(deletedPage, [3]);

  deletedPage = [];

  buf.cleanupAfter(20);
  assertEquals(deletedPage, [3]);
});

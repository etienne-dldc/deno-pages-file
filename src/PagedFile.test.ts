import { PagedFile } from "./PagedFile.ts";
import { assertEquals } from "https://deno.land/std@0.114.0/testing/asserts.ts";
import { encode } from "https://deno.land/std@0.114.0/encoding/hex.ts";
import { resolve } from "https://deno.land/std@0.114.0/path/mod.ts";

const decoder = new TextDecoder();

function _toHexString(data: Uint8Array): string {
  return decoder.decode(encode(data));
}

Deno.test("Create file", () => {
  const path = resolve(
    Deno.cwd(),
    "src",
    "fixture",
    Math.floor(Math.random() * 100000) + ".db",
  );
  const file = new PagedFile(path);
  file.save();
  assertEquals(file.debug(), []);
  file.close();
  Deno.removeSync(path);
});

Deno.test("Create root in file", () => {
  const path = resolve(
    Deno.cwd(),
    "src",
    "fixture",
    Math.floor(Math.random() * 100000) + ".db",
  );
  const file = new PagedFile(path, { pageSize: 256 });
  file.readRootPage();
  file.save();
  assertEquals(file.debug(), [
    "000: Root [pageSize: 256, emptylistAddr: 0, nextPage: 0]",
  ]);
  file.close();
  Deno.removeSync(path);
});

Deno.test("Write root", () => {
  const path = resolve(
    Deno.cwd(),
    "src",
    "fixture",
    Math.floor(Math.random() * 100000) + ".db",
  );
  const file = new PagedFile(path, { pageSize: 256 });
  file.writeRootPage(new Uint8Array([255, 255, 255]));
  assertEquals(file.readRootPage(0, 3), new Uint8Array([255, 255, 255]));
  file.save();
  file.close();
  const file2 = new PagedFile(path, { pageSize: 256 });
  assertEquals(file2.readRootPage(0, 3), new Uint8Array([255, 255, 255]));
  assertEquals(file2.debug(), [
    "000: Root [pageSize: 256, emptylistAddr: 0, nextPage: 0]",
  ]);
  file2.close();
  Deno.removeSync(path);
});

Deno.test("Write root without saving", () => {
  const path = resolve(
    Deno.cwd(),
    "src",
    "fixture",
    Math.floor(Math.random() * 100000) + ".db",
  );
  const file = new PagedFile(path, { pageSize: 256 });
  file.writeRootPage(new Uint8Array([255, 255, 255]));
  assertEquals(file.readRootPage(0, 3), new Uint8Array([255, 255, 255]));
  file.close();
  const file2 = new PagedFile(path, { pageSize: 256 });
  assertEquals(file2.readRootPage(0, 3), new Uint8Array([0, 0, 0]));
  assertEquals(file2.debug(), []);
  file2.close();
  Deno.removeSync(path);
});

Deno.test("Write root multi pages", () => {
  const path = resolve(
    Deno.cwd(),
    "src",
    "fixture",
    Math.floor(Math.random() * 100000) + ".db",
  );
  const file = new PagedFile(path, { pageSize: 256 });
  file.writeRootPage(new Uint8Array(300));
  file.save();
  assertEquals(file.debug(), [
    "000: Root [pageSize: 256, emptylistAddr: 0, nextPage: 1]",
    "001: Data [prevPage: 0, nextPage: 0]",
  ]);
  file.close();
  Deno.removeSync(path);
});

Deno.test("Write root multi pages at index", () => {
  const path = resolve(
    Deno.cwd(),
    "src",
    "fixture",
    Math.floor(Math.random() * 100000) + ".db",
  );
  const file = new PagedFile(path, { pageSize: 256 });
  file.writeRootPage(new Uint8Array(300), 260);
  file.save();
  assertEquals(file.debug(), [
    "000: Root [pageSize: 256, emptylistAddr: 0, nextPage: 1]",
    "001: Data [prevPage: 0, nextPage: 2]",
    "002: Data [prevPage: 0, nextPage: 0]",
  ]);
  file.close();
  Deno.removeSync(path);
});

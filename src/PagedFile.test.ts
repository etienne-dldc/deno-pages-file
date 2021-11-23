import { PagedFile } from "./PagedFile.ts";
import { assertEquals } from "https://deno.land/std@0.114.0/testing/asserts.ts";
import { encode } from "https://deno.land/std@0.114.0/encoding/hex.ts";
import { resolve } from "https://deno.land/std@0.114.0/path/mod.ts";

const decoder = new TextDecoder();

function _toHexString(data: Uint8Array): string {
  return decoder.decode(encode(data));
}

const fixtureFolder = resolve(
  Deno.cwd(),
  "src",
  "fixture",
);

try {
  Deno.mkdirSync(fixtureFolder);
} catch {
  //
}

Deno.test("Create file", () => {
  const path = resolve(
    fixtureFolder,
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
    fixtureFolder,
    Math.floor(Math.random() * 100000) + ".db",
  );
  const file = new PagedFile(path, { pageSize: 256 });
  file.getRootPage().read();
  file.save();
  assertEquals(file.debug(), [
    "000: Root [pageSize: 256, emptylistAddr: 0, nextPage: 0]",
  ]);
  file.close();
  Deno.removeSync(path);
});

Deno.test("Write root", () => {
  const path = resolve(
    fixtureFolder,
    Math.floor(Math.random() * 100000) + ".db",
  );
  const file = new PagedFile(path, { pageSize: 256 });
  file.getRootPage().write(new Uint8Array([255, 255, 255]));
  assertEquals(file.getRootPage().read(0, 3), new Uint8Array([255, 255, 255]));
  file.save();
  file.close();
  const file2 = new PagedFile(path, { pageSize: 256 });
  assertEquals(file2.getRootPage().read(0, 3), new Uint8Array([255, 255, 255]));
  assertEquals(file2.debug(), [
    "000: Root [pageSize: 256, emptylistAddr: 0, nextPage: 0]",
  ]);
  file2.close();
  Deno.removeSync(path);
});

Deno.test("Write root without saving", () => {
  const path = resolve(
    fixtureFolder,
    Math.floor(Math.random() * 100000) + ".db",
  );
  const file = new PagedFile(path, { pageSize: 256 });
  file.getRootPage().write(new Uint8Array([255, 255, 255]));
  assertEquals(file.getRootPage().read(0, 3), new Uint8Array([255, 255, 255]));
  file.close();
  const file2 = new PagedFile(path, { pageSize: 256 });
  assertEquals(file2.getRootPage().read(0, 3), new Uint8Array([0, 0, 0]));
  assertEquals(file2.debug(), []);
  file2.close();
  Deno.removeSync(path);
});

Deno.test("Write root multi pages", () => {
  const path = resolve(
    fixtureFolder,
    Math.floor(Math.random() * 100000) + ".db",
  );
  const file = new PagedFile(path, { pageSize: 256 });
  file.getRootPage().write(new Uint8Array(300));
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
    fixtureFolder,
    Math.floor(Math.random() * 100000) + ".db",
  );
  const file = new PagedFile(path, { pageSize: 256 });
  file.getRootPage().write(new Uint8Array(300), 260);
  file.save();
  assertEquals(file.debug(), [
    "000: Root [pageSize: 256, emptylistAddr: 0, nextPage: 1]",
    "001: Data [prevPage: 0, nextPage: 2]",
    "002: Data [prevPage: 0, nextPage: 0]",
  ]);
  file.close();
  Deno.removeSync(path);
});

Deno.test({
  name: "Create page",
  fn: () => {
    const path = resolve(
      fixtureFolder,
      Math.floor(Math.random() * 100000) + ".db",
    );
    const file = new PagedFile(path, { pageSize: 256 });
    const page = file.createPage();
    page.write(new Uint8Array(300), 260);
    file.save();
    assertEquals(file.debug(), [
      "000: Root [pageSize: 256, emptylistAddr: 0, nextPage: 0]",
      "001: Entry(4) [nextPage: 2]",
      "002: Data [prevPage: 0, nextPage: 3]",
      "003: Data [prevPage: 0, nextPage: 0]",
    ]);
    file.close();
    Deno.removeSync(path);
  },
});

Deno.test("Create page custom type", () => {
  const path = resolve(
    fixtureFolder,
    Math.floor(Math.random() * 100000) + ".db",
  );
  const file = new PagedFile(path, { pageSize: 256 });
  const page = file.createPage(42);
  const content = new Uint8Array(300);
  content.set(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 0);
  page.write(content);
  file.save();
  assertEquals(file.debug(), [
    "000: Root [pageSize: 256, emptylistAddr: 0, nextPage: 0]",
    "001: Entry(46) [nextPage: 2]",
    "002: Data [prevPage: 0, nextPage: 0]",
  ]);
  file.close();
  const file2 = new PagedFile(path, { pageSize: 256 });
  const page2 = file2.getPage(page.addr, 42);
  assertEquals(
    page2.read(0, 10),
    new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
  );
  file2.close();
  Deno.removeSync(path);
});

Deno.test("Can read / wripe page even if cache is clean", () => {
  const path = resolve(
    fixtureFolder,
    Math.floor(Math.random() * 100000) + ".db",
  );
  const file = new PagedFile(path, { pageSize: 256, cacheSize: 0 });
  const page = file.createPage();
  file.save();
  assertEquals(file.debug(), [
    "000: Root [pageSize: 256, emptylistAddr: 0, nextPage: 0]",
    "001: Entry(4) [nextPage: 0]",
  ]);
  const content = new Uint8Array(300);
  content.set(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 0);
  page.write(content);
  file.save();
  assertEquals(
    page.read(0, 10),
    new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
  );
  assertEquals(file.debug(), [
    "000: Root [pageSize: 256, emptylistAddr: 0, nextPage: 0]",
    "001: Entry(4) [nextPage: 2]",
    "002: Data [prevPage: 0, nextPage: 0]",
  ]);
  file.close();
});

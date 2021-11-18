import { resolve } from "https://deno.land/std/path/mod.ts";
import { PagedFile } from "../mod.ts";

const path = resolve(Deno.cwd(), "example", "file.db");

const file = new PagedFile(path, { pageSize: 256 });

const encoder = new TextEncoder();
// const decoder = new TextDecoder();

// file.readRootPage();

// file.save();

file.debug();

file.getRootPage().writeAndCleanup(
  encoder.encode(
    [
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
    ].join(""),
  ),
);

file.save();

file.debug();

file.getRootPage().writeAndCleanup(
  encoder.encode(
    [
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
    ].join(""),
  ),
);

file.save();

file.debug();

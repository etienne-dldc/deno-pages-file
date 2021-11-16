import { resolve } from "https://deno.land/std/path/mod.ts";
import { PagedFile } from "./src/mod.ts";

const path = resolve(Deno.cwd(), "file.db");

const file = new PagedFile(path, { pageSize: 256 });

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const res = file.readRootPage();

console.log(decoder.decode(res.buffer));

// file.debug();

file.writeRootPage(
  encoder.encode(
    [
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
    ].join("")
  )
);

file.save();

// file.debug();

// file.writeRootPage(
//   encoder.encode(
//     [
//       "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
//     ].join("")
//   )
// );

// file.debug();

// const dataAddr = file.createPage();

// file.writePage(
//   dataAddr,
//   encoder.encode(
//     [
//       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
//       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
//       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
//       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
//       "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
//     ].join("")
//   )
// );

// file.save();

// file.debug();

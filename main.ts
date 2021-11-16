import { resolve } from "https://deno.land/std/path/mod.ts";
import { PagedFile } from "./src/mod.ts";

const path = resolve(Deno.cwd(), "file.db");

const file = new PagedFile(path, 256);

const encoder = new TextEncoder();

file.debug();

file.writeRoot(
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

file.debug();

file.writeRoot(
  encoder.encode(
    [
      "Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root, Hello Root",
    ].join("")
  )
);

file.save();

file.debug();

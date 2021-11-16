# Paged file

> Deno lib to store data on a file using pages

## Usage

```ts
export { PagedFile } from "https://deno.land/x/paged_file/mod.ts";

const file = new PagedFile("file.db");

const rootContent = file.readRootPage(); // Uint8Array

const pageAddr = file.createPage(); // number (page address)

const someData = new Uint8Array();

file.writePage(pageAddr, someData);

// persist changes to the disk
file.save();

const pageData = file.readPage(pageAddr);
```

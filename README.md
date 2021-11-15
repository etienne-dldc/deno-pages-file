# deno-pages-file

> Store data on file using pages

## Spec

The file is splitted into pages of fixed size.
Page size can be: `256`, `512`, `1024`, `2048`, `4096`, `8192`, `16384` or `32768`.

### Page Type

Each page has a type defined by the first byte:

- `0`: Root Page (very first page)
- `1`: Freelist Page (page used to store empty pages)
- `2`: Data Page
- `3`-`255`: Entry Pages (the page type number is left for use by the application)

### Page index

A page is identified by its index. The root page has index `0`.
Page index are stored on `2 bytes` meaning the maximun page index is `65 535` (`2^(8*2) - 1`).
The page index `0` is used as a null value since `0` is the index of the root page.

### Page details

#### Entry Page

- `1 byte`: Page type `3`-`255`
- `2 bytes`: Next page index (or `0` if not)
- `PAGE_SIZE-3 bytes`: Data

#### Root Page

The root page is the very first page. It's similar to an entry page except type is 0 and it contains some additional data.

- `1 byte`: Page Type `0`
- `2 bytes`: Page Size
- `2 bytes`: Freelist Page index
- `2 bytes`: Next page index (or `0` if not)
- `PAGE_SIZE-7 bytes`: Data

#### Freelist Page

Freelist page are used to keep track of empty page (only trailing pages can be removed, any other page is referenced here to be recycled ♻️).

- `1 byte`: Page type `1`
- `2 bytes`: Prev Page index (or `0` if first)
- `2 bytes`: Next Page index (or `0` if last)
- `PAGE_SIZE-5 bytes`: List of empty pages

#### Data Page

Data page contains data that overflow from an Entry page or the root page.

- `1 byte`: Page type `2`
- `2 bytes`: Prev Page index (or `0` if first)
- `2 bytes`: Next Page index (or `0` if last)
- `PAGE_SIZE-5 bytes`: Data

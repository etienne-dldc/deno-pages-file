import { ReadBlock } from "./ReadBlock.ts";
import { WriteBlock } from "./WriteBlock.ts";

const encoder = new TextEncoder();

export const Block = {
  uint8: { read: ReadBlock.uint8, write: WriteBlock.uint8 },
  uint16: { read: ReadBlock.uint16, write: WriteBlock.uint16 },
  uint32: { read: ReadBlock.uint32, write: WriteBlock.uint32 },
  float64: { read: ReadBlock.float64, write: WriteBlock.float64 },
  encodedUint: { read: ReadBlock.encodedUint, write: WriteBlock.encodedUint },
  encodedString: {
    read: ReadBlock.encodedString,
    write: WriteBlock.encodedString,
  },
  staticString(str: string) {
    const buf = encoder.encode(str);
    return {
      read: ReadBlock.fixedString(buf.byteLength),
      write: WriteBlock.transform(
        WriteBlock.bufferFixed(buf.byteLength),
        () => buf,
      ),
    };
  },
} as const;

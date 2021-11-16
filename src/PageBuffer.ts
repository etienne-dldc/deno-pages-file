/**
 * Adapted from
 * - https://deno.land/x/btrdb@v0.5.1
 * - https://deno.land/x/bytes@1.0.3
 */

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

const tmpbuf = new ArrayBuffer(8);
const f64arr = new Float64Array(tmpbuf);
const u8arr = new Uint8Array(tmpbuf);

export class PageBuffer {
  protected buffer: Uint8Array;
  protected _position = 0;
  protected onBeforeWriting?: ((size: number) => void) | undefined;

  public read: PageBufferRead;
  public readNext: PageBufferRead;
  public write: PageBufferWrite;
  public writeNext: PageBufferWrite;

  constructor(
    buffer: Uint8Array,
    pos = 0,
    onBeforeWriting?: (size: number) => void
  ) {
    this.buffer = buffer;
    this._position = pos;
    this.onBeforeWriting = onBeforeWriting;
    const setPos = (v: number) => {
      this._position = v;
    };
    // deno-lint-ignore no-this-alias
    const parent = this;
    const ref: PageBufferRef = {
      buffer: this.buffer,
      beforeWriting: this.beforeWriting,
      onBeforeWriting,
      get pos() {
        return parent._position;
      },
      set pos(p: number) {
        setPos(p);
      },
    };
    this.read = new PageBufferRead(ref, false);
    this.readNext = new PageBufferRead(ref, true);
    this.write = new PageBufferWrite(ref, false);
    this.writeNext = new PageBufferWrite(ref, true);
  }

  public seek(position: number): this {
    this._position = position;
    return this;
  }

  public reset(): this {
    this.seek(0);
    return this;
  }

  public subarray(begin?: number, end?: number) {
    return this.buffer.subarray(begin, end);
  }

  public withOffset(begin: number = this._position) {
    return new PageBuffer(
      this.subarray(begin),
      Math.max(0, this._position - begin),
      this.onBeforeWriting
    );
  }

  public mergeWith(other: PageBuffer): PageBuffer {
    const size = this.byteLength + other.byteLength;
    const resultArr = new Uint8Array(size);
    resultArr.set(this.buffer);
    resultArr.set(other.reset().read.buffer(other.byteLength), this.byteLength);
    return new PageBuffer(resultArr);
  }

  public get byteLength() {
    return this.buffer.byteLength;
  }

  public get position() {
    return this._position;
  }

  public beforeWriting(size: number) {
    if (this.onBeforeWriting) {
      this.onBeforeWriting(size);
    }
  }

  static calcStringSize(str: string) {
    let bytes = 0;
    const len = str.length;
    for (let i = 0; i < len; i++) {
      const codePoint = str.charCodeAt(i);
      if (codePoint < 0x80) {
        bytes += 1;
      } else if (codePoint < 0x800) {
        bytes += 2;
      } else if (codePoint >= 0xd800 && codePoint < 0xe000) {
        if (codePoint < 0xdc00 && i + 1 < len) {
          const next = str.charCodeAt(i + 1);
          if (next >= 0xdc00 && next < 0xe000) {
            bytes += 4;
            i++;
          } else {
            bytes += 3;
          }
        } else {
          bytes += 3;
        }
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  static calcLenEncodedStringSize(str: string) {
    const len = PageBuffer.calcStringSize(str);
    return PageBuffer.calcEncodedUintSize(len) + len;
  }

  static calcLenEncodedBufferSize(buf: Uint8Array) {
    return PageBuffer.calcEncodedUintSize(buf.length) + buf.length;
  }

  static calcEncodedUintSize(len: number) {
    return len < 254 ? 1 : len < 65536 ? 3 : 5;
  }
}

export class DynamicPageBuffer extends PageBuffer {
  constructor(initSize = 32) {
    super(new Uint8Array(initSize));
  }
  beforeWriting(size: number) {
    super.beforeWriting(size);
    const minsize = this._position + size;
    if (minsize > this.buffer.byteLength) {
      let newsize = this.buffer.byteLength * 4;
      while (minsize > newsize) {
        newsize *= 4;
      }
      const newBuffer = new Uint8Array(newsize);
      newBuffer.set(this.buffer);
      this.buffer = newBuffer;
    }
  }
}

type PageBufferRef = {
  buffer: Uint8Array;
  pos: number;
  beforeWriting(len: number): void;
  onBeforeWriting?: (size: number) => void;
};

class PageBufferWrite {
  private bufferPage: PageBufferRef;
  private isNext: boolean;

  constructor(parent: PageBufferRef, isNext: boolean) {
    this.bufferPage = parent;
    this.isNext = isNext;
  }

  float64(num: number) {
    this.bufferPage.beforeWriting(8);
    f64arr[0] = num;
    this.buffer(u8arr);
  }

  uint32(num: number) {
    this.bufferPage.beforeWriting(4);
    this.bufferPage.buffer[this.bufferPage.pos] = (num >>> 24) & 0xff;
    this.bufferPage.buffer[this.bufferPage.pos + 1] = (num >>> 16) & 0xff;
    this.bufferPage.buffer[this.bufferPage.pos + 2] = (num >>> 8) & 0xff;
    this.bufferPage.buffer[this.bufferPage.pos + 3] = num & 0xff;
    if (this.isNext) {
      this.bufferPage.pos += 4;
    }
  }

  uint16(num: number) {
    this.bufferPage.beforeWriting(2);
    this.bufferPage.buffer[this.bufferPage.pos] = (num >> 8) & 0xff;
    this.bufferPage.buffer[this.bufferPage.pos + 1] = num & 0xff;
    if (this.isNext) {
      this.bufferPage.pos += 2;
    }
  }

  uint8(num: number) {
    this.bufferPage.beforeWriting(1);
    this.bufferPage.buffer[this.bufferPage.pos] = num & 0xff;
    if (this.isNext) {
      this.bufferPage.pos += 1;
    }
  }

  buffer(buf: Uint8Array) {
    this.bufferPage.beforeWriting(buf.byteLength);
    this.bufferPage.buffer.set(buf, this.bufferPage.pos);
    if (this.isNext) {
      this.bufferPage.pos += buf.byteLength;
    }
  }

  string(str: string) {
    const len = PageBuffer.calcStringSize(str);
    this.encodedUint(len);
    this.bufferPage.beforeWriting(len);
    const r = encoder.encodeInto(
      str,
      this.bufferPage.buffer.subarray(this.bufferPage.pos)
    );
    if (this.isNext) {
      this.bufferPage.pos += r.written;
    }
  }

  lenEncodedBuffer(buf: Uint8Array) {
    this.encodedUint(buf.length);
    this.buffer(buf);
  }

  encodedUint(val: number) {
    if (val < 254) {
      this.uint8(val);
    } else if (val < 65536) {
      this.uint8(254);
      this.uint16(val);
    } else {
      this.uint8(255);
      this.uint32(val);
    }
  }
}

class PageBufferRead {
  private parent: PageBufferRef;
  private isNext: boolean;

  constructor(buf: PageBufferRef, isNext: boolean) {
    this.parent = buf;
    this.isNext = isNext;
  }

  float64() {
    for (let i = 0; i < 8; i++) {
      u8arr[i] = this.parent.buffer[this.parent.pos + i];
    }
    if (this.isNext) {
      this.parent.pos += 8;
    }
    return f64arr[0];
  }

  uint32() {
    const res =
      ((this.parent.buffer[this.parent.pos] << 24) |
        (this.parent.buffer[this.parent.pos + 1] << 16) |
        (this.parent.buffer[this.parent.pos + 2] << 8) |
        this.parent.buffer[this.parent.pos + 3]) >>>
      0;
    if (this.isNext) {
      this.parent.pos += 4;
    }
    return res;
  }

  uint16() {
    const res =
      (this.parent.buffer[this.parent.pos] << 8) |
      this.parent.buffer[this.parent.pos + 1];
    if (this.isNext) {
      this.parent.pos += 2;
    }
    return res;
  }

  uint8() {
    const res = this.parent.buffer[this.parent.pos];
    if (this.isNext) {
      this.parent.pos += 1;
    }
    return res;
  }

  buffer(len: number) {
    const buf = this.parent.buffer.slice(
      this.parent.pos,
      this.parent.pos + len
    );
    if (this.isNext) {
      this.parent.pos += len;
    }
    return buf;
  }

  bufferReadonly(len: number) {
    const buf = this.parent.buffer.subarray(
      this.parent.pos,
      this.parent.pos + len
    );
    if (this.isNext) {
      this.parent.pos += len;
    }
    return buf;
  }

  copyReadonly() {
    const buf = this.parent.buffer.subarray();
    return buf;
  }

  pageBuffer(len: number) {
    return new PageBuffer(this.buffer(len), 0, this.parent.onBeforeWriting);
  }

  encodedUint() {
    const val = this.uint8();
    if (val < 254) {
      return val;
    } else if (val == 254) {
      return this.uint16();
    } else {
      return this.uint32();
    }
  }

  string() {
    const len = this.encodedUint();
    const str = decoder.decode(
      this.parent.buffer.subarray(this.parent.pos, this.parent.pos + len)
    );
    if (this.isNext) {
      this.parent.pos += len;
    }
    return str;
  }
}

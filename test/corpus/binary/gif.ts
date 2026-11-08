// A minimal GIF89a writer: one global 256-color palette, any number of
// frames, LZW-compressed, looping forever when there is more than one frame.

export type GifFrame = {
  /** One palette index per pixel, row-major, width * height long. */
  indices: Uint8Array;
  /** Delay before the next frame, in hundredths of a second. */
  delay: number;
};

export type Gif = {
  width: number;
  height: number;
  /** 256 RGB entries, 768 bytes. */
  palette: Buffer;
  frames: GifFrame[];
};

class BitWriter {
  readonly bytes: number[] = [];
  #acc = 0;
  #bits = 0;

  write(code: number, width: number): void {
    this.#acc |= code << this.#bits;
    this.#bits += width;
    while (this.#bits >= 8) {
      this.bytes.push(this.#acc & 0xff);
      this.#acc >>>= 8;
      this.#bits -= 8;
    }
  }

  flush(): void {
    if (this.#bits > 0) this.bytes.push(this.#acc & 0xff);
    this.#acc = 0;
    this.#bits = 0;
  }
}

/** GIF's variable-width LZW, with 8-bit symbols and a 12-bit code limit. */
export function lzwEncode(indices: Uint8Array, minCodeSize = 8): Buffer {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out = new BitWriter();
  let table = new Map<number, number>();
  let next = end + 1;
  let width = minCodeSize + 1;
  out.write(clear, width);
  if (indices.length === 0) {
    out.write(end, width);
    out.flush();
    return Buffer.from(out.bytes);
  }
  let prefix = indices[0] as number;
  for (let i = 1; i < indices.length; i++) {
    const symbol = indices[i] as number;
    const key = (prefix << 8) | symbol;
    const known = table.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    out.write(prefix, width);
    if (next < 4096) {
      table.set(key, next++);
      // The decoder widens one code later than the encoder adds the entry.
      if (next > 1 << width && width < 12) width++;
    } else {
      out.write(clear, width);
      table = new Map();
      next = end + 1;
      width = minCodeSize + 1;
    }
    prefix = symbol;
  }
  out.write(prefix, width);
  out.write(end, width);
  out.flush();
  return Buffer.from(out.bytes);
}

function subBlocks(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const piece = data.subarray(i, i + 255);
    parts.push(Buffer.from([piece.length]), piece);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

export function encodeGif(gif: Gif): Buffer {
  const { width, height, palette, frames } = gif;
  if (palette.length !== 768) throw new Error("a GIF palette has 256 RGB entries");
  if (frames.length === 0) throw new Error("a GIF needs at least one frame");
  const parts: Buffer[] = [Buffer.from("GIF89a", "ascii")];
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  screen[4] = 0xf7; // global color table, 8-bit color resolution, 256 entries
  parts.push(screen, palette);
  if (frames.length > 1) {
    // NETSCAPE2.0 application extension: loop forever.
    parts.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from("NETSCAPE2.0", "ascii"), Buffer.from([3, 1, 0, 0, 0]));
  }
  for (const frame of frames) {
    if (frame.indices.length !== width * height) throw new Error("frame size does not match the image");
    const control = Buffer.from([0x21, 0xf9, 4, 0x04, 0, 0, 0, 0]); // dispose: leave in place
    control.writeUInt16LE(frame.delay, 4);
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(0, 1);
    descriptor.writeUInt16LE(0, 3);
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    descriptor[9] = 0; // no local color table, not interlaced
    parts.push(control, descriptor, Buffer.from([8]), subBlocks(lzwEncode(frame.indices, 8)));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

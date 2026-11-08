// A minimal PNG writer: 8-bit RGB or RGBA, filter type 0, one IDAT chunk.
// Enough to produce valid images of any size the corpus needs.

import { crc32, deflateSync } from "node:zlib";

export type Pixels = {
  width: number;
  height: number;
  /** Bytes per pixel: 3 (RGB) or 4 (RGBA). */
  channels: 3 | 4;
  /** Row-major pixel bytes, width * height * channels long. */
  data: Buffer;
};

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

export type PngOptions = {
  /** zlib level 0-9; 0 stores the data, which keeps noise images at full size. */
  level?: number;
};

export function encodePng(pixels: Pixels, options: PngOptions = {}): Buffer {
  const { width, height, channels, data } = pixels;
  if (data.length !== width * height * channels) throw new Error("pixel data has the wrong length");
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // color type: RGBA or RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: options.level ?? 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

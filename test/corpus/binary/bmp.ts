// Minimal BMP and ICO writers.

import { encodePng, type Pixels } from "./png.ts";

/** A 24-bit uncompressed BMP (BITMAPINFOHEADER, rows bottom-up). */
export function encodeBmp(pixels: Pixels): Buffer {
  const { width, height, channels, data } = pixels;
  const stride = Math.ceil((width * 3) / 4) * 4;
  const imageSize = stride * height;
  const out = Buffer.alloc(54 + imageSize);
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10); // pixel data offset
  out.writeUInt32LE(40, 14); // header size
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26); // planes
  out.writeUInt16LE(24, 28); // bits per pixel
  out.writeUInt32LE(0, 30); // no compression
  out.writeUInt32LE(imageSize, 34);
  out.writeInt32LE(2835, 38); // 72 dpi
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * channels;
      out[row + x * 3] = data[src + 2] as number; // blue
      out[row + x * 3 + 1] = data[src + 1] as number; // green
      out[row + x * 3 + 2] = data[src] as number; // red
    }
  }
  return out;
}

/** An ICO with one PNG-encoded image, the form every current reader accepts. */
export function encodeIco(pixels: Pixels): Buffer {
  if (pixels.width > 256 || pixels.height > 256) throw new Error("an icon image is at most 256x256");
  const png = encodePng(pixels);
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(1, 4); // one image
  head[6] = pixels.width === 256 ? 0 : pixels.width;
  head[7] = pixels.height === 256 ? 0 : pixels.height;
  head[8] = 0; // no palette
  head[9] = 0;
  head.writeUInt16LE(1, 10); // color planes
  head.writeUInt16LE(32, 12); // bits per pixel
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18); // offset of the image
  return Buffer.concat([head, png]);
}

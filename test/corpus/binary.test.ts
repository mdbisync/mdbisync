// Structural tests of the corpus file writers. They check what a decoder
// relies on (headers, sizes, checksums, offsets); the writers' output was
// also decoded by a browser when they were written.

import { test } from "node:test";
import assert from "node:assert/strict";
import { brotliDecompressSync, crc32, inflateSync } from "node:zlib";
import { encodeBmp, encodeIco } from "./binary/bmp.ts";
import { encodeTtf, encodeWoff2 } from "./binary/font.ts";
import { encodeGif, lzwEncode } from "./binary/gif.ts";
import { encodeJpeg } from "./binary/jpeg.ts";
import { encodeEmptyMp4, encodeSilentMp3 } from "./binary/media.ts";
import { encodePdf } from "./binary/pdf.ts";
import { encodePng } from "./binary/png.ts";
import { encodeWebp } from "./binary/webp.ts";
import { encodeZip } from "./binary/zip.ts";
import { Rng } from "./rng.ts";

const rng = new Rng("binary-tests");

test("PNG: every chunk CRC holds and the data inflates to one filter byte per row", () => {
  for (const [w, h, channels] of [[1, 1, 4], [37, 21, 3], [300, 2, 4]] as const) {
    const png = encodePng({ width: w, height: h, channels, data: rng.bytes(w * h * channels) });
    let i = 8;
    let idat = Buffer.alloc(0);
    while (i < png.length) {
      const n = png.readUInt32BE(i);
      const kind = png.subarray(i + 4, i + 8);
      const body = png.subarray(i + 8, i + 8 + n);
      assert.equal(png.readUInt32BE(i + 8 + n), crc32(Buffer.concat([kind, body])) >>> 0);
      if (kind.toString() === "IDAT") idat = Buffer.concat([idat, body]);
      i += 12 + n;
    }
    assert.equal(inflateSync(idat).length, h * (w * channels + 1));
  }
});

/** GIF LZW decoding as the GIF89a specification describes it. */
function lzwDecode(data: Buffer, minCodeSize: number): number[] {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let width = minCodeSize + 1;
  let table: number[][] = [];
  const reset = () => {
    table = Array.from({ length: clear }, (_, k) => [k]);
    table.push([], []);
    width = minCodeSize + 1;
  };
  reset();
  const out: number[] = [];
  let bit = 0;
  let previous: number[] | null = null;
  for (;;) {
    let code = 0;
    for (let k = 0; k < width; k++, bit++) code |= ((data[bit >> 3]! >> (bit & 7)) & 1) << k;
    if (code === clear) {
      reset();
      previous = null;
      continue;
    }
    if (code === end) return out;
    let entry: number[];
    if (code < table.length) entry = table[code]!;
    else if (previous !== null && code === table.length) entry = [...previous, previous[0]!];
    else throw new Error(`bad code ${code}`);
    out.push(...entry);
    if (previous !== null && table.length < 4096) table.push([...previous, entry[0]!]);
    if (table.length === 1 << width && width < 12) width++;
    previous = entry;
  }
}

test("GIF: LZW output decodes back to the same indices, across every code width", () => {
  for (const length of [0, 1, 2, 300, 70_000]) {
    const indices = new Uint8Array(length);
    for (let i = 0; i < length; i++) indices[i] = i % 3 === 0 ? rng.int(0, 255) : (indices[i - 1] ?? 0);
    assert.deepEqual(lzwDecode(lzwEncode(indices, 8), 8), [...indices]);
  }
  const gif = encodeGif({ width: 4, height: 3, palette: Buffer.alloc(768), frames: [{ indices: new Uint8Array(12), delay: 0 }, { indices: new Uint8Array(12).fill(1), delay: 5 }] });
  assert.equal(gif.subarray(0, 6).toString(), "GIF89a");
  assert.equal(gif.readUInt16LE(6), 4);
  assert.equal(gif.readUInt16LE(8), 3);
  assert.ok(gif.includes(Buffer.from("NETSCAPE2.0")), "an animation loops");
  assert.equal(gif.at(-1), 0x3b);
});

test("JPEG: markers in order and the frame header carries the size", () => {
  for (const [w, h] of [[1, 1], [37, 21], [4000, 3000]] as const) {
    const blocks = new Uint8Array(Math.ceil(w / 8) * Math.ceil(h / 8) * 3).map(() => rng.int(0, 255));
    const jpeg = encodeJpeg({ width: w, height: h, blocks });
    assert.deepEqual([...jpeg.subarray(0, 2)], [0xff, 0xd8]);
    assert.deepEqual([...jpeg.subarray(-2)], [0xff, 0xd9]);
    const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    assert.equal(jpeg.readUInt16BE(sof + 5), h);
    assert.equal(jpeg.readUInt16BE(sof + 7), w);
    // Entropy-coded data never holds an unstuffed 0xFF followed by a non-zero byte.
    const scan = jpeg.subarray(jpeg.indexOf(Buffer.from([0xff, 0xda])) + 14, -2);
    for (let i = 0; i < scan.length - 1; i++) if (scan[i] === 0xff) assert.equal(scan[i + 1], 0x00);
  }
});

test("WebP: RIFF sizes and the VP8L header carry the size", () => {
  const webp = encodeWebp({ width: 640, height: 7, red: [0, 255], green: [1, 2], blue: [3, 4], choices: new Uint8Array(640 * 7).map(() => rng.int(0, 7)) });
  assert.equal(webp.subarray(0, 4).toString(), "RIFF");
  assert.equal(webp.readUInt32LE(4), webp.length - 8);
  assert.equal(webp.subarray(8, 16).toString(), "WEBPVP8L");
  assert.equal(webp[20], 0x2f);
  const bits = webp.readUInt32LE(21);
  assert.equal((bits & 0x3fff) + 1, 640);
  assert.equal(((bits >>> 14) & 0x3fff) + 1, 7);
});

test("BMP and ICO: headers carry the size and point at the pixels", () => {
  const bmp = encodeBmp({ width: 5, height: 3, channels: 3, data: rng.bytes(45) });
  assert.equal(bmp.subarray(0, 2).toString(), "BM");
  assert.equal(bmp.readUInt32LE(2), bmp.length);
  assert.equal(bmp.readInt32LE(18), 5);
  assert.equal(bmp.length, 54 + 16 * 3); // rows padded to four bytes
  const ico = encodeIco({ width: 256, height: 256, channels: 4, data: rng.bytes(256 * 256 * 4) });
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico[6], 0, "256 is written as 0");
  assert.equal(ico.readUInt32LE(14), ico.length - 22);
  assert.deepEqual([...ico.subarray(22, 26)], [0x89, 0x50, 0x4e, 0x47]);
});

test("ZIP: local headers, CRCs and the central directory agree", () => {
  const entries = [{ name: "a.txt", data: Buffer.from("one\n") }, { name: "dir/été.csv", data: rng.bytes(300) }];
  const zip = encodeZip(entries);
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), 2);
  let offset = 0;
  for (const entry of entries) {
    assert.equal(zip.readUInt32LE(offset), 0x04034b50);
    const nameLength = zip.readUInt16LE(offset + 26);
    assert.equal(zip.subarray(offset + 30, offset + 30 + nameLength).toString(), entry.name);
    assert.equal(zip.readUInt32LE(offset + 14), crc32(entry.data) >>> 0);
    offset += 30 + nameLength + entry.data.length;
  }
  assert.equal(zip.readUInt32LE(end + 16), offset, "the central directory starts after the entries");
});

test("PDF: every xref offset points at its object and the page count is right", () => {
  const pdf = encodePdf([{ lines: ["One (1)", "back\\slash"] }, { lines: ["Two"], image: { width: 4, height: 2, rgb: rng.bytes(24) } }], "Title");
  const text = pdf.toString("latin1");
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
  assert.equal(text.slice(start, start + 5), "xref\n");
  const count = Number(/^xref\n0 (\d+)\n/.exec(text.slice(start))![1]);
  const entriesAt = start + text.slice(start).indexOf("\n", 5) + 1;
  for (let i = 1; i < count; i++) {
    const offset = Number(text.slice(entriesAt + i * 20, entriesAt + i * 20 + 10));
    assert.ok(text.startsWith(`${i} 0 obj\n`, offset), `object ${i}`);
  }
  assert.match(text, /\/Type \/Pages \/Kids \[[^\]]+\] \/Count 2 >>/);
});

function sfntChecksum(buffer: Buffer): number {
  const padded = Buffer.concat([buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4)]);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

test("TrueType: table checksums and the whole-font adjustment hold", () => {
  const ttf = encodeTtf("Check Face");
  const count = ttf.readUInt16BE(4);
  const tags: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = ttf.toString("ascii", at, at + 4);
    tags.push(tag);
    const offset = ttf.readUInt32BE(at + 8);
    const table = Buffer.from(ttf.subarray(offset, offset + ttf.readUInt32BE(at + 12)));
    if (tag === "head") table.writeUInt32BE(0, 8);
    assert.equal(ttf.readUInt32BE(at + 4), sfntChecksum(table), tag);
  }
  assert.deepEqual(tags, [...tags].sort(), "the directory is sorted by tag");
  for (const required of ["OS/2", "cmap", "glyf", "head", "hhea", "hmtx", "loca", "maxp", "name", "post"]) assert.ok(tags.includes(required), required);
  assert.equal(sfntChecksum(ttf), 0xb1b0afba);
});

test("WOFF2: the header is consistent and the stream decompresses to the font's tables", () => {
  const woff2 = encodeWoff2("Check Face");
  const ttf = encodeTtf("Check Face");
  assert.equal(woff2.subarray(0, 4).toString(), "wOF2");
  assert.equal(woff2.readUInt32BE(8), woff2.length);
  assert.equal(woff2.readUInt32BE(16), ttf.length);
  const count = woff2.readUInt16BE(12);
  // Directory: one flag byte and one or more base-128 length bytes per table.
  let at = 48;
  let total = 0;
  for (let i = 0; i < count; i++) {
    at++;
    let length = 0;
    for (;;) {
      const byte = woff2[at++]!;
      length = length * 128 + (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    total += length;
  }
  const compressed = woff2.subarray(at, at + woff2.readUInt32BE(20));
  assert.equal(brotliDecompressSync(compressed).length, total);
});

test("MP3 frames start with the sync word and MP4 boxes add up to the file", () => {
  const mp3 = encodeSilentMp3(10);
  assert.equal(mp3.length, 4170);
  for (let i = 0; i < mp3.length; i += 417) assert.deepEqual([...mp3.subarray(i, i + 2)], [0xff, 0xfb]);
  const mp4 = encodeEmptyMp4(3, 100);
  const kinds: string[] = [];
  let i = 0;
  while (i < mp4.length) {
    kinds.push(mp4.toString("ascii", i + 4, i + 8));
    i += mp4.readUInt32BE(i);
  }
  assert.equal(i, mp4.length);
  assert.deepEqual(kinds, ["ftyp", "moov", "free"]);
});

// A minimal valid TrueType font built from scratch: three glyphs (.notdef,
// space, and a triangle for "A"), with every table browsers require. The
// same outlines are written as .ttf, as .otf (an OpenType file may hold
// TrueType outlines) and as WOFF2 (Brotli, no table transforms).

import { brotliCompressSync, constants } from "node:zlib";

type Glyph = { contours: [number, number][][]; advance: number };

const UNITS_PER_EM = 1000;

function glyphs(): Glyph[] {
  return [
    // .notdef: a hollow box
    {
      contours: [
        [[50, 0], [50, 700], [450, 700], [450, 0]],
        [[100, 50], [400, 50], [400, 650], [100, 650]],
      ],
      advance: 500,
    },
    { contours: [], advance: 250 }, // space
    { contours: [[[20, 0], [300, 700], [580, 0]]], advance: 600 }, // A
  ];
}

function glyphData(glyph: Glyph): Buffer {
  if (glyph.contours.length === 0) return Buffer.alloc(0);
  const points = glyph.contours.flat();
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const parts: number[] = [];
  const u16 = (v: number) => parts.push((v >> 8) & 0xff, v & 0xff);
  u16(glyph.contours.length);
  for (const v of [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]) u16(v);
  let end = -1;
  for (const contour of glyph.contours) {
    end += contour.length;
    u16(end);
  }
  u16(0); // no instructions
  for (let i = 0; i < points.length; i++) parts.push(0x01); // on-curve, 16-bit deltas
  let previous = 0;
  for (const x of xs) {
    u16((x - previous) & 0xffff);
    previous = x;
  }
  previous = 0;
  for (const y of ys) {
    u16((y - previous) & 0xffff);
    previous = y;
  }
  return Buffer.from(parts);
}

function pad4(buffer: Buffer): Buffer {
  const rest = buffer.length % 4;
  return rest === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(4 - rest)]);
}

function checksum(buffer: Buffer): number {
  const padded = pad4(buffer);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

function nameTable(family: string): Buffer {
  const records: [number, string][] = [
    [1, family],
    [2, "Regular"],
    [3, `${family} Regular 1.000`],
    [4, `${family} Regular`],
    [5, "Version 1.000"],
    [6, `${family.replace(/[^A-Za-z0-9]/g, "")}-Regular`],
  ];
  const strings = records.map(([, text]) => Buffer.from(text, "utf16le").swap16());
  const head = Buffer.alloc(6 + records.length * 12);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(records.length, 2);
  head.writeUInt16BE(head.length, 4);
  let offset = 0;
  records.forEach(([id], i) => {
    const at = 6 + i * 12;
    head.writeUInt16BE(3, at); // Windows
    head.writeUInt16BE(1, at + 2); // Unicode BMP
    head.writeUInt16BE(0x409, at + 4); // English (US)
    head.writeUInt16BE(id, at + 6);
    head.writeUInt16BE((strings[i] as Buffer).length, at + 8);
    head.writeUInt16BE(offset, at + 10);
    offset += (strings[i] as Buffer).length;
  });
  return Buffer.concat([head, ...strings]);
}

function cmapTable(): Buffer {
  // Format 4 with segments for space (glyph 1), "A" (glyph 2) and the end marker.
  const segments = [
    { start: 0x20, end: 0x20, delta: 1 - 0x20 },
    { start: 0x41, end: 0x41, delta: 2 - 0x41 },
    { start: 0xffff, end: 0xffff, delta: 1 },
  ];
  const segCount = segments.length;
  const sub = Buffer.alloc(16 + segCount * 8);
  sub.writeUInt16BE(4, 0);
  sub.writeUInt16BE(sub.length, 2);
  sub.writeUInt16BE(0, 4); // language
  const searchRange = 2 * 2 ** Math.floor(Math.log2(segCount));
  sub.writeUInt16BE(segCount * 2, 6);
  sub.writeUInt16BE(searchRange, 8);
  sub.writeUInt16BE(Math.floor(Math.log2(segCount)), 10);
  sub.writeUInt16BE(segCount * 2 - searchRange, 12);
  segments.forEach((s, i) => {
    sub.writeUInt16BE(s.end, 14 + i * 2);
    sub.writeUInt16BE(s.start, 16 + segCount * 2 + i * 2);
    sub.writeUInt16BE(s.delta & 0xffff, 16 + segCount * 4 + i * 2);
    sub.writeUInt16BE(0, 16 + segCount * 6 + i * 2); // idRangeOffset
  });
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt16BE(3, 4); // Windows
  head.writeUInt16BE(1, 6); // Unicode BMP
  head.writeUInt32BE(12, 8);
  return Buffer.concat([head, sub]);
}

/** The font's tables, by tag, before the file layout is chosen. */
function buildTables(family: string): Map<string, Buffer> {
  const all = glyphs();
  const data = all.map(glyphData);
  // Short loca offsets are half the byte offset, so every glyph is 2-aligned.
  const aligned = data.map((d) => (d.length % 2 === 0 ? d : Buffer.concat([d, Buffer.alloc(1)])));
  const glyf = Buffer.concat(aligned);
  const loca = Buffer.alloc((all.length + 1) * 2);
  let at = 0;
  aligned.forEach((d, i) => {
    loca.writeUInt16BE(at / 2, i * 2);
    at += d.length;
  });
  loca.writeUInt16BE(at / 2, all.length * 2);

  const points = all.flatMap((g) => g.contours.flat());
  const xMin = Math.min(...points.map((p) => p[0]));
  const yMin = Math.min(...points.map((p) => p[1]));
  const xMax = Math.max(...points.map((p) => p[0]));
  const yMax = Math.max(...points.map((p) => p[1]));

  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(0x00010000, 4); // font revision 1.0
  head.writeUInt32BE(0, 8); // checksum adjustment, set later
  head.writeUInt32BE(0x5f0f3cf5, 12);
  head.writeUInt16BE(0x000b, 16); // flags
  head.writeUInt16BE(UNITS_PER_EM, 18);
  // created and modified: fixed at zero for reproducible output
  head.writeInt16BE(xMin, 36);
  head.writeInt16BE(yMin, 38);
  head.writeInt16BE(xMax, 40);
  head.writeInt16BE(yMax, 42);
  head.writeUInt16BE(0, 44); // mac style
  head.writeUInt16BE(8, 46); // lowest readable size
  head.writeInt16BE(2, 48); // font direction hint
  head.writeInt16BE(0, 50); // short loca
  head.writeInt16BE(0, 52); // glyph data format

  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(800, 4); // ascender
  hhea.writeInt16BE(-200, 6); // descender
  hhea.writeInt16BE(0, 8); // line gap
  hhea.writeUInt16BE(Math.max(...all.map((g) => g.advance)), 10);
  hhea.writeInt16BE(xMin, 12); // min left side bearing
  hhea.writeInt16BE(0, 14); // min right side bearing
  hhea.writeInt16BE(xMax, 16); // x max extent
  hhea.writeInt16BE(1, 18); // caret slope rise
  hhea.writeUInt16BE(all.length, 34); // number of h metrics

  const hmtx = Buffer.alloc(all.length * 4);
  all.forEach((g, i) => {
    hmtx.writeUInt16BE(g.advance, i * 4);
    const xs = g.contours.flat().map((p) => p[0]);
    hmtx.writeInt16BE(xs.length > 0 ? Math.min(...xs) : 0, i * 4 + 2);
  });

  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(all.length, 4);
  maxp.writeUInt16BE(Math.max(...all.map((g) => g.contours.flat().length)), 6);
  maxp.writeUInt16BE(Math.max(...all.map((g) => g.contours.length)), 8);
  maxp.writeUInt16BE(2, 14); // max zones

  const os2 = Buffer.alloc(96);
  os2.writeUInt16BE(4, 0); // version
  os2.writeInt16BE(450, 2); // average width
  os2.writeUInt16BE(400, 4); // weight
  os2.writeUInt16BE(5, 6); // width class
  os2.writeUInt16BE(0, 8); // embedding: installable
  os2.writeInt16BE(650, 10); // subscript x size
  os2.writeInt16BE(600, 12); // subscript y size
  os2.writeInt16BE(0, 14);
  os2.writeInt16BE(75, 16);
  os2.writeInt16BE(650, 18); // superscript x size
  os2.writeInt16BE(600, 20);
  os2.writeInt16BE(0, 22);
  os2.writeInt16BE(350, 24);
  os2.writeInt16BE(50, 26); // strikeout size
  os2.writeInt16BE(250, 28); // strikeout position
  os2.writeUInt32BE(1, 42); // Unicode range: Basic Latin
  os2.write("NONE", 58, "ascii"); // vendor id
  os2.writeUInt16BE(0x0040, 62); // REGULAR
  os2.writeUInt16BE(0x20, 64); // first char
  os2.writeUInt16BE(0x41, 66); // last char
  os2.writeInt16BE(800, 68); // typo ascender
  os2.writeInt16BE(-200, 70); // typo descender
  os2.writeInt16BE(0, 72); // typo line gap
  os2.writeUInt16BE(800, 74); // win ascent
  os2.writeUInt16BE(200, 76); // win descent
  os2.writeUInt32BE(1, 78); // code page: Latin 1
  os2.writeInt16BE(500, 86); // x height
  os2.writeInt16BE(700, 88); // cap height
  os2.writeUInt16BE(0, 90); // default char
  os2.writeUInt16BE(0x20, 92); // break char
  os2.writeUInt16BE(1, 94); // max context

  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0); // version 3: no glyph names
  post.writeInt16BE(-100, 8); // underline position
  post.writeInt16BE(50, 10); // underline thickness

  return new Map<string, Buffer>([
    ["OS/2", os2],
    ["cmap", cmapTable()],
    ["glyf", glyf],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", hmtx],
    ["loca", loca],
    ["maxp", maxp],
    ["name", nameTable(family)],
    ["post", post],
  ]);
}

/** Lays out an sfnt file and fills in the head checksum adjustment. */
function sfnt(tables: Map<string, Buffer>): Buffer {
  const tags = [...tables.keys()].sort();
  const count = tags.length;
  const searchRange = 16 * 2 ** Math.floor(Math.log2(count));
  const header = Buffer.alloc(12 + count * 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(count, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(Math.floor(Math.log2(count)), 8);
  header.writeUInt16BE(count * 16 - searchRange, 10);
  let offset = header.length;
  const bodies: Buffer[] = [];
  let headOffset = 0;
  tags.forEach((tag, i) => {
    const table = tables.get(tag) as Buffer;
    if (tag === "head") headOffset = offset;
    const at = 12 + i * 16;
    header.write(tag, at, "ascii");
    header.writeUInt32BE(checksum(table), at + 4);
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(table.length, at + 12);
    const padded = pad4(table);
    bodies.push(padded);
    offset += padded.length;
  });
  const font = Buffer.concat([header, ...bodies]);
  font.writeUInt32BE((0xb1b0afba - checksum(font)) >>> 0, headOffset + 8);
  return font;
}

export function encodeTtf(family: string): Buffer {
  return sfnt(buildTables(family));
}

/** The font as a .ttf, .otf (TrueType outlines) or .woff2 file. */
export function encodeFontFile(format: "ttf" | "otf" | "woff2", family: string): Buffer {
  return format === "woff2" ? encodeWoff2(family) : encodeTtf(family);
}

function base128(value: number): number[] {
  const out: number[] = [];
  do {
    out.unshift(value & 0x7f);
    value = Math.floor(value / 128);
  } while (value > 0);
  for (let i = 0; i < out.length - 1; i++) out[i] = (out[i] as number) | 0x80;
  return out;
}

// WOFF2 known-table indices for the tables this font has.
const KNOWN_TAGS: Record<string, number> = {
  cmap: 0, head: 1, hhea: 2, hmtx: 3, maxp: 4, name: 5, "OS/2": 6, post: 7, glyf: 10, loca: 11,
};

export function encodeWoff2(family: string): Buffer {
  const ttf = encodeTtf(family);
  // Read the finished tables back out of the TTF, so head carries its adjustment.
  const count = ttf.readUInt16BE(4);
  const tables = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = ttf.toString("ascii", at, at + 4);
    const offset = ttf.readUInt32BE(at + 8);
    tables.set(tag, ttf.subarray(offset, offset + ttf.readUInt32BE(at + 12)));
  }
  // loca must follow glyf directly in the directory.
  const order = ["OS/2", "cmap", "glyf", "loca", "head", "hhea", "hmtx", "maxp", "name", "post"];
  const directory: number[] = [];
  const data: Buffer[] = [];
  for (const tag of order) {
    const table = tables.get(tag) as Buffer;
    // Transform version 3 is the null transform for glyf and loca; 0 for the others.
    const version = tag === "glyf" || tag === "loca" ? 3 : 0;
    directory.push((version << 6) | (KNOWN_TAGS[tag] as number), ...base128(table.length));
    data.push(table);
  }
  const compressed = brotliCompressSync(Buffer.concat(data), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_FONT },
  });
  const header = Buffer.alloc(48);
  const body = pad4(Buffer.concat([Buffer.from(directory), compressed]));
  header.write("wOF2", 0, "ascii");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(48 + body.length, 8);
  header.writeUInt16BE(count, 12);
  header.writeUInt32BE(ttf.length, 16); // total sfnt size
  header.writeUInt32BE(compressed.length, 20);
  header.writeUInt16BE(1, 24); // major version
  return Buffer.concat([header, body]);
}

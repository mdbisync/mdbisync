// Images and attachments of the corpus, made by the generator itself.

import { encodeBmp, encodeIco } from "./binary/bmp.ts";
import { encodeFontFile } from "./binary/font.ts";
import { encodeGif } from "./binary/gif.ts";
import { blocksAcross, blocksDown, encodeJpeg } from "./binary/jpeg.ts";
import { encodeEmptyMp4, encodeSilentMp3 } from "./binary/media.ts";
import { encodePdf } from "./binary/pdf.ts";
import { encodePng, type Pixels } from "./binary/png.ts";
import { makeSvg } from "./binary/svg.ts";
import { encodeWebp } from "./binary/webp.ts";
import { encodeZip } from "./binary/zip.ts";
import { kindOf, LFS_FOLDER, NON_LFS_FOLDER, UPLOAD_LIMIT, type CorpusFile } from "./model.ts";
import type { Rng } from "./rng.ts";
import { paragraph, sentence, title, word } from "./text.ts";
import { HOMES, type Home } from "./tree.ts";

/** An image or attachment a document can embed or link to. */
export type AssetRef = {
  path: string;
  kind: "image" | "attachment";
  /** Short text for alt text or link text. */
  label: string;
  /** Set when Linear's upload limit leaves the file, and so its documents, out. */
  tooLarge: boolean;
};

export type Assets = {
  files: CorpusFile[];
  /** Assets waiting for a document, per home folder. */
  queues: Map<string, AssetRef[]>;
  /** The image that exactly 40 documents embed. */
  shared: AssetRef;
  /** A second small image for tables, pairwise documents and lint cases. */
  secondary: AssetRef;
};

function asset(path: string, content: Buffer, group: "images" | "attachments", note: string | null = null): CorpusFile {
  const tooLarge = content.length > UPLOAD_LIMIT;
  return {
    path,
    content,
    group,
    kind: kindOf(path),
    synced: false,
    canary: null,
    canaryIn: null,
    expected: null,
    rule: tooLarge ? "upload-too-large" : null,
    basis: null,
    macosUnsafe: false,
    bankGroup: null,
    links: [],
    note,
  };
}

/** A color gradient; with texture, a fine pattern that compresses less, for small images. */
function gradient(width: number, height: number, channels: 3 | 4, rng: Rng, texture = true): Pixels {
  const data = Buffer.alloc(width * height * channels);
  const [r0, g0, b0] = [rng.int(0, 255), rng.int(0, 255), rng.int(0, 255)];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      data[i] = (r0 + Math.floor((x * 255) / Math.max(1, width))) & 0xff;
      data[i + 1] = (g0 + Math.floor((y * 255) / Math.max(1, height))) & 0xff;
      data[i + 2] = (b0 + (texture ? (x ^ y) & 0x3f : Math.floor((x + y) / 64))) & 0xff;
      if (channels === 4) data[i + 3] = 255;
    }
  }
  return { width, height, channels, data };
}

function gifImage(rng: Rng, width: number, height: number, frames: number): Buffer {
  const palette = rng.bytes(768);
  return encodeGif({
    width,
    height,
    palette,
    frames: Array.from({ length: frames }, (_, f) => {
      const indices = new Uint8Array(width * height);
      for (let i = 0; i < indices.length; i++) indices[i] = ((i % width) + Math.floor(i / width) + f * 16) & 0xff;
      return { indices, delay: 10 + rng.int(0, 40) };
    }),
  });
}

function jpegImage(rng: Rng, width: number, height: number): Buffer {
  const count = blocksAcross(width) * blocksDown(height);
  const blocks = new Uint8Array(count * 3);
  const base = [rng.int(40, 200), rng.int(60, 190), rng.int(60, 190)];
  for (let b = 0; b < count; b++) {
    blocks[b * 3] = Math.min(255, (base[0] as number) + (b % 32));
    blocks[b * 3 + 1] = base[1] as number;
    blocks[b * 3 + 2] = Math.min(255, (base[2] as number) + ((b >> 5) % 32));
  }
  return encodeJpeg({ width, height, blocks });
}

function webpImage(rng: Rng, width: number, height: number): Buffer {
  const choices = new Uint8Array(width * height);
  for (let i = 0; i < choices.length; i++) choices[i] = (((i % width) >> 3) + (Math.floor(i / width) >> 3)) % 8;
  return encodeWebp({ width, height, red: [rng.int(0, 100), rng.int(150, 255)], green: [rng.int(0, 100), rng.int(150, 255)], blue: [rng.int(0, 100), rng.int(150, 255)], choices });
}

type ImageFormat = "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico";

function makeImage(rng: Rng, format: ImageFormat, width: number, height: number, animated = false): Buffer {
  // Large images stay smooth so that only the one noise image is over the upload limit.
  const texture = width * height <= 1_000_000;
  switch (format) {
    case "png":
      return encodePng(gradient(width, height, rng.bool() ? 4 : 3, rng, texture));
    case "jpg":
    case "jpeg":
      return jpegImage(rng, width, height);
    case "gif":
      return gifImage(rng, width, height, animated ? rng.int(2, 6) : 1);
    case "webp":
      return webpImage(rng, width, height);
    case "svg":
      return Buffer.from(makeSvg(rng, { width, height, shapes: rng.int(3, 20), ...(rng.bool(0.3) ? { label: title(rng) } : {}) }));
    case "bmp":
      return encodeBmp(gradient(width, height, 3, rng));
    case "ico":
      return encodeIco(gradient(Math.min(width, 256), Math.min(height, 256), 4, rng));
  }
}

const SIZES: [number, number][] = [
  [1, 1], [2, 2], [8, 8], [16, 16], [24, 24], [32, 32], [48, 48], [64, 48], [100, 60], [120, 120],
  [160, 90], [200, 150], [256, 256], [320, 240], [400, 300], [480, 270], [640, 360], [800, 600],
];

export function makeAssets(rng: Rng): Assets {
  const files: CorpusFile[] = [];
  const queues = new Map<string, AssetRef[]>(HOMES.map((h) => [h.path, []]));
  const enqueue = (home: Home, file: CorpusFile, label: string): AssetRef => {
    files.push(file);
    const ref: AssetRef = { path: file.path, kind: file.group === "images" ? "image" : "attachment", label, tooLarge: file.rule === "upload-too-large" };
    queues.get(home.path)?.push(ref);
    return ref;
  };
  let n = 0;
  const homeFor = (): Home => HOMES[n++ % HOMES.length] as Home;
  const name = (base: string, ext: string) => `${base}-${String(files.length + 1).padStart(3, "0")}.${ext}`;

  // The small non-LFS set: 40 tiny images in inline/ folders.
  const tinyFormats: ImageFormat[] = ["png", "gif", "bmp", "png"];
  for (let i = 0; i < 40; i++) {
    const home = homeFor();
    const format = tinyFormats[i % tinyFormats.length] as ImageFormat;
    const side = [1, 2, 4, 8, 16][i % 5] as number;
    enqueue(home, asset(`${home.path}/${NON_LFS_FOLDER}/${name("icon", format)}`, makeImage(rng, format, side, side), "images"), `icon ${i + 1}`);
  }

  // LFS images across formats and sizes.
  const plan: [ImageFormat, number][] = [["png", 70], ["jpg", 45], ["jpeg", 15], ["gif", 40], ["webp", 40], ["svg", 35], ["bmp", 30], ["ico", 30]];
  for (const [format, count] of plan) {
    for (let i = 0; i < count; i++) {
      const home = homeFor();
      const [w, h] = SIZES[(i * 7 + format.length) % SIZES.length] as [number, number];
      const animated = format === "gif" && i % 2 === 0;
      const base = animated ? "animation" : rng.pick(["diagram", "screenshot", "chart", "photo", "sketch", "banner"]);
      enqueue(home, asset(`${home.path}/assets/${name(base, format)}`, makeImage(rng, format, w, h, animated), "images"), `${base} ${word(rng)}`);
    }
  }

  // Large images: the full size range, and one over Linear's upload limit.
  const big: [ImageFormat, number, number, string][] = [
    ["jpg", 4000, 3000, "panorama"],
    ["png", 4000, 3000, "poster"],
    ["webp", 1600, 1200, "board"],
    ["gif", 1024, 768, "walkthrough"],
  ];
  for (const [format, w, h, base] of big) {
    const home = homeFor();
    enqueue(home, asset(`${home.path}/assets/${name(base, format)}`, makeImage(rng, format, w, h, format === "gif"), "images", `${w}x${h}`), base);
  }
  {
    // Noise does not compress: 2000x1800 RGB stored is about 10.8 MB.
    const home = homeFor();
    const pixels: Pixels = { width: 2000, height: 1800, channels: 3, data: rng.bytes(2000 * 1800 * 3) };
    enqueue(home, asset(`${home.path}/assets/${name("scan-full-resolution", "png")}`, encodePng(pixels, { level: 0 }), "images", "over the upload limit"), "full resolution scan");
  }

  // The image that 40 documents share; it is not queued, documents ask for it.
  const sharedFile = asset("docs/handbook/assets/shared-logo.png", encodePng(gradient(120, 40, 4, rng)), "images", "embedded by 40 documents");
  files.push(sharedFile);
  const shared: AssetRef = { path: sharedFile.path, kind: "image", label: "team logo", tooLarge: false };
  const secondaryFile = asset("eng/platform/assets/status-icon.png", encodePng(gradient(24, 24, 4, rng)), "images", "embedded by tables, pairwise and lint documents");
  files.push(secondaryFile);
  const secondary: AssetRef = { path: secondaryFile.path, kind: "image", label: "status icon", tooLarge: false };

  // Attachments in media/ folders, which are stored in LFS whatever the extension.
  const attach = (base: string, ext: string, content: Buffer, label: string, note: string | null = null) => {
    const home = homeFor();
    enqueue(home, asset(`${home.path}/${LFS_FOLDER}/${name(base, ext)}`, content, "attachments", note), label);
  };
  for (let i = 0; i < 8; i++) attach("brief", "pdf", encodePdf([{ lines: [title(rng), sentence(rng), sentence(rng)] }], title(rng)), "one-page brief");
  for (let i = 0; i < 6; i++) {
    const pages = rng.int(5, 40);
    attach("handbook", "pdf", encodePdf(Array.from({ length: pages }, (_, p) => ({ lines: [`Section ${p + 1}`, sentence(rng), sentence(rng)] })), title(rng)), `${pages}-page handbook`);
  }
  attach("scan-9mb", "pdf", encodePdf([{ lines: ["Scanned contract"], image: { width: 2000, height: 1500, rgb: rng.bytes(2000 * 1500 * 3) } }], "Scanned contract"), "scanned contract", "about 9 MB, under the upload limit");
  attach("scan-11mb", "pdf", encodePdf([{ lines: ["Scanned archive"], image: { width: 2000, height: 1920, rgb: rng.bytes(2000 * 1920 * 3) } }], "Scanned archive"), "scanned archive", "about 11 MB, over the upload limit");
  for (const format of ["woff2", "ttf", "otf"] as const) {
    for (let i = 0; i < 3; i++) attach("typeface", format, encodeFontFile(format, `Sample Face ${i + 1}`), `${format} typeface`);
  }
  for (let i = 0; i < 6; i++) {
    attach("bundle", "zip", encodeZip([
      { name: "readme.txt", data: Buffer.from(`${paragraph(rng)}\n`) },
      { name: `data/${word(rng)}.csv`, data: Buffer.from(`id,value\n1,${rng.int(1, 999)}\n2,${rng.int(1, 999)}\n`) },
    ]), "release bundle");
  }
  for (let i = 0; i < 7; i++) {
    const rows = Array.from({ length: rng.int(3, 40) }, (_, r) => `${r + 1},${word(rng)},${rng.int(0, 10000)}`);
    attach("export", "csv", Buffer.from(`id,item,amount\n${rows.join("\n")}\n`), "data export");
  }
  for (let i = 0; i < 7; i++) {
    attach("settings", "json", Buffer.from(`${JSON.stringify({ name: title(rng), enabled: rng.bool(), limits: { daily: rng.int(1, 100) } }, null, 2)}\n`), "settings file");
  }
  for (let i = 0; i < 4; i++) attach("recording", "mp4", encodeEmptyMp4(rng.int(1, 30), rng.int(512, 65536)), "screen recording");
  for (let i = 0; i < 4; i++) attach("voice-note", "mp3", encodeSilentMp3(rng.int(20, 400)), "voice note");
  for (let i = 0; i < 7; i++) attach("notes", "txt", Buffer.from(`${paragraph(rng)}\n\n${paragraph(rng)}\n`), "plain text notes");

  return { files, queues, shared, secondary };
}

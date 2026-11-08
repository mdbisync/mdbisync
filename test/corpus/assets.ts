// Images and attachments of the corpus, made by the generator itself:
// screenshots, charts, diagrams, route maps and landscape photos drawn by
// code, and attachments with believable content.

import { createHash } from "node:crypto";
import { encodeBmp, encodeIco } from "./binary/bmp.ts";
import { Canvas, mix, type Rgb } from "./binary/draw.ts";
import { encodeFontFile } from "./binary/font.ts";
import { encodeGif } from "./binary/gif.ts";
import { blocksAcross, blocksDown, encodeJpeg } from "./binary/jpeg.ts";
import { encodeEmptyMp4, encodeSilentMp3 } from "./binary/media.ts";
import { encodePdf } from "./binary/pdf.ts";
import { encodePng, type Pixels } from "./binary/png.ts";
import { encodeWebp } from "./binary/webp.ts";
import { encodeZip } from "./binary/zip.ts";
import { COMPANY, CUSTOMERS, DEPOTS, PROFILES, type Profile } from "./company.ts";
import { kindOf, LFS_FOLDER, NON_LFS_FOLDER, UPLOAD_LIMIT, type CorpusFile } from "./model.ts";
import { ACCENTS, render, svgPicture, type PictureSpec, type Scene } from "./pictures.ts";
import type { Rng } from "./rng.ts";
import { HOMES, EDGE, type Home } from "./tree.ts";
import { slugify } from "./writing.ts";

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
  /** Files over the upload limit, for the edge-case documents. */
  oversized: AssetRef[];
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

// ---------------------------------------------------------------- encoders for drawn pictures

/**
 * The JPEG writer codes one color per 8x8 block, so the picture is drawn at
 * one eighth of the size, one pixel per block, and each pixel becomes a block.
 */
function jpegFrom(c: Canvas, width: number, height: number): Buffer {
  const across = blocksAcross(width);
  const down = blocksDown(height);
  const blocks = new Uint8Array(across * down * 3);
  for (let by = 0; by < down; by++) {
    for (let bx = 0; bx < across; bx++) {
      const [r, g, b] = c.get(Math.min(c.width - 1, bx), Math.min(c.height - 1, by));
      const i = (by * across + bx) * 3;
      blocks[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      blocks[i + 1] = Math.max(0, Math.min(255, Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b)));
      blocks[i + 2] = Math.max(0, Math.min(255, Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b)));
    }
  }
  return encodeJpeg({ width, height, blocks });
}

/** A 6x6x6 color cube plus 40 grays. */
const GIF_PALETTE: Buffer = (() => {
  const p = Buffer.alloc(768);
  let i = 0;
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) p.set([r * 51, g * 51, b * 51], 3 * i++);
  for (let k = 0; k < 40; k++) p.set([Math.round((k * 255) / 39), Math.round((k * 255) / 39), Math.round((k * 255) / 39)], 3 * i++);
  return p;
})();

function gifIndices(c: Canvas): Uint8Array {
  const out = new Uint8Array(c.width * c.height);
  for (let p = 0; p < out.length; p++) {
    const r = c.data[p * 3] as number;
    const g = c.data[p * 3 + 1] as number;
    const b = c.data[p * 3 + 2] as number;
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    out[p] = spread < 12 ? 216 + Math.round((((r + g + b) / 3) * 39) / 255) : Math.round(r / 51) * 36 + Math.round(g / 51) * 6 + Math.round(b / 51);
  }
  return out;
}

function webpFrom(c: Canvas, levels: { red: [number, number]; green: [number, number]; blue: [number, number] }): Buffer {
  const choices = new Uint8Array(c.width * c.height);
  const mid = (l: [number, number]) => (l[0] + l[1]) / 2;
  for (let p = 0; p < choices.length; p++) {
    choices[p] = ((c.data[p * 3] as number) > mid(levels.red) ? 1 : 0) | ((c.data[p * 3 + 1] as number) > mid(levels.green) ? 2 : 0) | ((c.data[p * 3 + 2] as number) > mid(levels.blue) ? 4 : 0);
  }
  return encodeWebp({ width: c.width, height: c.height, ...levels, choices });
}

// ---------------------------------------------------------------- what pictures show

const PHOTOS = ["Team day at the lake", "Harbor depot at sunrise", "View from the Northgate office", "Offsite in the hills", "Evening shift at Riverside", "Winter morning on the coast"];
const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT"];
const WEEKS = ["W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "W10"];

function titleCase(upper: string): string {
  const lowerText = upper.toLowerCase();
  return lowerText.charAt(0).toUpperCase() + lowerText.slice(1);
}

type Picture = { spec: PictureSpec; label: string; base: string };

function picture(rng: Rng, profile: Profile, scene: Scene): Picture {
  const accent = rng.pick(ACCENTS);
  switch (scene) {
    case "screenshot": {
      const screen = rng.pick(profile.screens);
      return { spec: { scene, title: screen, labels: profile.labels, accent }, label: `${titleCase(screen)} screen`, base: `screenshot-${slugify(screen)}` };
    }
    case "phone": {
      const screen = rng.pick(PROFILES["eng/mobile app"]?.screens ?? ["TODAY"]);
      const stops = rng.shuffle(CUSTOMERS).slice(0, 4).map((c) => c.toUpperCase());
      return { spec: { scene, title: screen, labels: stops, accent }, label: `Driver app, ${titleCase(screen).toLowerCase()} screen`, base: `phone-${slugify(screen)}` };
    }
    case "bar-chart":
    case "line-chart": {
      const chart = rng.pick(profile.charts);
      const labels = scene === "bar-chart" ? WEEKDAYS : WEEKS;
      return { spec: { scene, title: chart, labels, accent }, label: `Chart: ${titleCase(chart).toLowerCase()}`, base: `chart-${slugify(chart)}` };
    }
    case "donut-chart": {
      const chart = rng.pick(profile.charts);
      return { spec: { scene, title: chart, labels: profile.labels.slice(0, 4), accent }, label: `Chart: ${titleCase(chart).toLowerCase()} by part`, base: `chart-${slugify(chart)}-split` };
    }
    case "diagram":
      return { spec: { scene, title: `${profile.name.toUpperCase()} FLOW`, labels: profile.labels, accent }, label: `Diagram: how work flows through ${profile.name.toLowerCase()}`, base: `diagram-${slugify(profile.name)}` };
    case "map": {
      const depot = rng.pick(DEPOTS);
      return { spec: { scene, title: depot.toUpperCase(), labels: rng.shuffle(CUSTOMERS).slice(0, rng.int(3, 7)), accent }, label: `Route map, ${depot} depot`, base: `map-${slugify(depot)}` };
    }
    case "photo": {
      const name = rng.pick(PHOTOS);
      return { spec: { scene, title: "", labels: [], accent }, label: name, base: `photo-${slugify(name)}` };
    }
    case "icon":
      return { spec: { scene, title: "", labels: [], accent }, label: `${profile.name} icon`, base: `icon-${slugify(profile.name)}` };
  }
}

type ImageFormat = "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico";

/** Which scenes each format draws, and at which sizes. */
const PLAN: { format: ImageFormat; count: number; scenes: Scene[]; sizes: [number, number][] }[] = [
  { format: "png", count: 70, scenes: ["screenshot", "screenshot", "phone", "bar-chart", "map", "line-chart", "donut-chart", "diagram"], sizes: [[960, 600], [1280, 800], [800, 500], [1024, 640], [390, 780], [720, 405], [32, 32], [64, 64]] },
  { format: "jpg", count: 45, scenes: ["photo"], sizes: [[1200, 800], [900, 600], [1600, 1000], [800, 600], [640, 480], [160, 90]] },
  { format: "jpeg", count: 15, scenes: ["photo"], sizes: [[1024, 683], [800, 533], [480, 320], [120, 120]] },
  { format: "gif", count: 40, scenes: ["bar-chart", "line-chart", "phone", "diagram"], sizes: [[640, 360], [480, 270], [320, 640], [560, 315], [48, 48]] },
  { format: "webp", count: 40, scenes: ["bar-chart", "diagram", "line-chart", "donut-chart", "map"], sizes: [[800, 450], [640, 360], [960, 540], [400, 300], [160, 96]] },
  { format: "svg", count: 35, scenes: ["bar-chart", "line-chart", "donut-chart", "diagram"], sizes: [[800, 450], [640, 360], [960, 540], [24, 24]] },
  { format: "bmp", count: 30, scenes: ["bar-chart", "diagram", "icon", "line-chart"], sizes: [[400, 300], [320, 240], [256, 256], [200, 150], [8, 8], [2, 2]] },
  { format: "ico", count: 30, scenes: ["icon"], sizes: [[16, 16], [24, 24], [32, 32], [48, 48], [64, 64], [128, 128], [256, 256]] },
];

/** Two levels per channel for the eight-color WebP writer, near the accent colors. */
const WEBP_LEVELS = { red: [30, 236] as [number, number], green: [64, 205] as [number, number], blue: [70, 240] as [number, number] };

function encodeImage(rng: Rng, format: ImageFormat, width: number, height: number, pic: Picture, animated: boolean): Buffer {
  switch (format) {
    case "svg":
      return Buffer.from(svgPicture(width, height, rng, pic.spec, pic.label));
    case "gif": {
      const frames = animated ? rng.int(4, 6) : 1;
      const seed = rng.hex(8);
      return encodeGif({
        width,
        height,
        palette: GIF_PALETTE,
        frames: Array.from({ length: frames }, (_, f) => ({
          // Every frame draws from the same seed, so only the progress moves.
          indices: gifIndices(render(width, height, rng.fork(seed), { ...pic.spec, progress: animated ? (f + 1) / frames : 1 })),
          delay: f === frames - 1 ? 150 : 25,
        })),
      });
    }
    case "jpg":
    case "jpeg":
      return jpegFrom(render(blocksAcross(width), blocksDown(height), rng, pic.spec), width, height);
    default: {
      const c = render(width, height, rng, pic.spec);
      switch (format) {
        case "png":
          return encodePng(c.pixels(rng.bool() ? 4 : 3));
        case "webp":
          return webpFrom(c, WEBP_LEVELS);
        case "bmp":
          return encodeBmp(c.pixels(3));
        case "ico":
          return encodeIco(c.pixels(4));
      }
    }
  }
}

function logo(width: number, height: number): Pixels {
  const c = new Canvas(width, height, [255, 255, 255]);
  const accent: Rgb = [37, 99, 235];
  c.roundRect(2, 2, height - 4, height - 4, (height - 4) * 0.25, accent);
  c.triangle([height * 0.28, height * 0.66], [height * 0.72, height * 0.3], [height * 0.6, height * 0.72], [255, 255, 255]);
  c.text(height + 4, height / 2 - 7, COMPANY.toUpperCase(), mix(accent, [17, 24, 39], 0.6), 2);
  return c.pixels(4);
}

function statusIcon(): Pixels {
  const c = new Canvas(24, 24, [255, 255, 255]);
  c.circle(11.5, 11.5, 11, [22, 163, 74]);
  c.line(6, 12, 10, 16, [255, 255, 255], 2.5);
  c.line(10, 16, 17, 8, [255, 255, 255], 2.5);
  return c.pixels(4);
}

// ---------------------------------------------------------------- attachments

function csvExport(rng: Rng): string {
  const days = rng.int(5, 30);
  const rows = Array.from({ length: days * 2 }, (_, i) => {
    const deliveries = rng.int(180, 950);
    return `2026-${String(rng.int(1, 10)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")},${rng.pick(DEPOTS)},${deliveries},${Math.round(deliveries * (0.86 + rng.next() * 0.12))},${rng.int(0, 14)}`;
  });
  return `date,depot,deliveries,on_time,failed\n${rows.join("\n")}\n`;
}

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
  const profileOf = (home: Home) => PROFILES[home.path] as Profile;
  // Uploads are deduplicated by content, so every image must have its own bytes:
  // a picture that repeats an earlier one is drawn again from a fresh fork of the seed.
  const digests = new Set<string>();
  const distinct = (draw: (r: Rng) => Buffer): Buffer => {
    for (let attempt = 0; ; attempt++) {
      const bytes = draw(attempt === 0 ? rng : rng.fork(`redraw-${files.length}-${attempt}`));
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (!digests.has(digest)) {
        digests.add(digest);
        return bytes;
      }
      if (attempt > 20) throw new Error(`cannot draw a distinct image for ${files.length}`);
    }
  };

  // The small non-LFS set: 40 tiny status icons in inline/ folders.
  const tinyFormats: ("png" | "gif" | "bmp")[] = ["png", "gif", "bmp", "png"];
  const statusNames = ["green", "amber", "red", "blue", "violet"];
  for (let i = 0; i < 40; i++) {
    const home = homeFor();
    const format = tinyFormats[i % tinyFormats.length] as ImageFormat;
    const side = [1, 2, 4, 8, 16][i % 5] as number;
    const color = statusNames[i % statusNames.length] as string;
    // Each icon gets its own shade so no two files are equal.
    const accent = mix(ACCENTS[i % ACCENTS.length] as Rgb, [255, 255, 255], (i % 7) / 20);
    const pic: Picture = { spec: { scene: "icon", title: "", labels: [], accent }, label: `${color} status dot`, base: `status-${color}` };
    enqueue(home, asset(`${home.path}/${NON_LFS_FOLDER}/${name(pic.base, format)}`, distinct((r) => encodeImage(r, format, side, side, pic, false)), "images"), pic.label);
  }

  // LFS images across formats, scenes and sizes.
  for (const { format, count, scenes, sizes } of PLAN) {
    for (let i = 0; i < count; i++) {
      const home = homeFor();
      const [w, h] = sizes[i % sizes.length] as [number, number];
      // Phones are drawn upright and app windows wide, whatever the plan pairs them with.
      const planned = scenes[(i * 3 + 1) % scenes.length] as Scene;
      const scene: Scene = planned === "phone" && w > h ? "screenshot" : planned === "screenshot" && h > w ? "phone" : planned;
      const pic = picture(rng, profileOf(home), scene);
      const animated = format === "gif" && i % 2 === 0;
      const label = animated ? `${pic.label} (animated)` : pic.label;
      enqueue(home, asset(`${home.path}/images/${name(pic.base, format)}`, distinct((r) => encodeImage(r, format, w, h, pic, animated)), "images"), label);
    }
  }

  // Large images: the full size range.
  const big: [ImageFormat, number, number, Scene, string][] = [
    ["jpg", 4000, 3000, "photo", "panorama"],
    ["png", 4000, 3000, "screenshot", "wall-display"],
    ["webp", 1600, 1200, "diagram", "whiteboard"],
    ["gif", 1024, 768, "bar-chart", "walkthrough"],
  ];
  for (const [format, w, h, scene, base] of big) {
    const home = homeFor();
    const pic = picture(rng, profileOf(home), scene);
    enqueue(home, asset(`${home.path}/images/${name(base, format)}`, encodeImage(rng, format, w, h, pic, format === "gif"), "images", `${w}x${h}`), `${pic.label}, full size`);
  }

  // The image that 40 documents share, and a small status icon; documents ask for them.
  const sharedFile = asset("docs/handbook/assets/shared-logo.png", encodePng(logo(150, 40)), "images", "embedded by 40 documents");
  files.push(sharedFile);
  const shared: AssetRef = { path: sharedFile.path, kind: "image", label: `${COMPANY} logo`, tooLarge: false };
  const secondaryFile = asset("eng/platform/assets/status-icon.png", encodePng(statusIcon()), "images", "embedded by tables, pairwise and lint documents");
  files.push(secondaryFile);
  const secondary: AssetRef = { path: secondaryFile.path, kind: "image", label: "status icon", tooLarge: false };

  // Attachments in media/ folders, which are stored in LFS whatever the extension.
  const attach = (base: string, ext: string, content: Buffer, label: string, note: string | null = null) => {
    const home = homeFor();
    enqueue(home, asset(`${home.path}/${LFS_FOLDER}/${name(base, ext)}`, content, "attachments", note), label);
  };
  const topicsOf = () => profileOf(HOMES[n % HOMES.length] as Home).topics;
  for (let i = 0; i < 8; i++) {
    const topic = rng.pick(topicsOf().length > 0 ? topicsOf() : (PROFILES["eng/platform"] as Profile).topics);
    attach(`brief-${slugify(topic.title)}`, "pdf", encodePdf([{ lines: [topic.title, "", topic.summary, topic.problem, topic.change] }], topic.title), `One-page brief: ${topic.title.toLowerCase()}`);
  }
  for (let i = 0; i < 6; i++) {
    const profile = profileOf(HOMES[n % HOMES.length] as Home);
    const pages = profile.topics.length > 0 ? profile.topics : (PROFILES["docs/handbook"] as Profile).topics;
    attach(`${slugify(profile.name)}-guide`, "pdf", encodePdf(pages.map((tp, p) => ({ lines: [`${p + 1}. ${tp.title}`, "", tp.summary, tp.problem, tp.change, tp.risk] })), `${profile.name} guide`), `${profile.name} guide (PDF, ${pages.length} pages)`);
  }
  for (const format of ["woff2", "ttf", "otf"] as const) {
    // The family name includes the format, so a .ttf and an .otf never share their bytes.
    for (let i = 0; i < 3; i++) attach(`${COMPANY.toLowerCase()}-sans-${["regular", "medium", "bold"][i]}`, format, encodeFontFile(format, `${COMPANY} Sans ${format.toUpperCase()} ${i + 1}`), `${COMPANY} Sans typeface (${format})`);
  }
  for (let i = 0; i < 6; i++) {
    attach("design-assets", "zip", encodeZip([
      { name: "readme.txt", data: Buffer.from(`Brand assets for ${COMPANY}, set ${i + 1}. Use the logo on white or on the brand blue only.\n`) },
      { name: `data/deliveries-${i + 1}.csv`, data: Buffer.from(csvExport(rng)) },
    ]), "Design assets bundle");
  }
  for (let i = 0; i < 7; i++) attach("deliveries-export", "csv", Buffer.from(csvExport(rng)), "Deliveries export (CSV)");
  for (let i = 0; i < 7; i++) {
    const depot = rng.pick(DEPOTS);
    attach(`depot-settings-${slugify(depot)}`, "json", Buffer.from(`${JSON.stringify({ depot, opensAt: `0${rng.int(5, 7)}:00`, vans: rng.int(6, 40), planning: { timeBudgetSeconds: rng.int(30, 240), respectTimeWindows: rng.bool() } }, null, 2)}\n`), `Depot settings, ${depot}`);
  }
  for (let i = 0; i < 4; i++) attach("screen-recording", "mp4", encodeEmptyMp4(rng.int(1, 30), rng.int(512, 65536)), "Screen recording of the walkthrough");
  for (let i = 0; i < 4; i++) attach("voice-note", "mp3", encodeSilentMp3(rng.int(20, 400)), "Voice note from the depot visit");
  for (let i = 0; i < 7; i++) {
    const topic = rng.pick((PROFILES["eng/backend"] as Profile).topics);
    attach("meeting-notes", "txt", Buffer.from(`Notes ${i + 1}, ${topic.title}\n\n${topic.problem}\n\n${topic.change}\n`), "Raw meeting notes (text)");
  }

  // Files over the upload limit and close to it, for the edge-case documents. Noise does not compress.
  const oversized: AssetRef[] = [];
  const edgeFile = (file: CorpusFile, label: string) => {
    files.push(file);
    oversized.push({ path: file.path, kind: file.group === "images" ? "image" : "attachment", label, tooLarge: file.rule === "upload-too-large" });
  };
  const noise: Pixels = { width: 2000, height: 1800, channels: 3, data: rng.bytes(2000 * 1800 * 3) };
  edgeFile(asset(`${EDGE}/images/scan-full-resolution.png`, encodePng(noise, { level: 0 }), "images", "over the upload limit"), "full resolution scan");
  edgeFile(asset(`${EDGE}/${LFS_FOLDER}/scan-9mb.pdf`, encodePdf([{ lines: ["Scanned contract"], image: { width: 2000, height: 1500, rgb: rng.bytes(2000 * 1500 * 3) } }], "Scanned contract"), "attachments", "about 9 MB, under the upload limit"), "scanned contract");
  edgeFile(asset(`${EDGE}/${LFS_FOLDER}/scan-11mb.pdf`, encodePdf([{ lines: ["Scanned archive"], image: { width: 2000, height: 1920, rgb: rng.bytes(2000 * 1920 * 3) } }], "Scanned archive"), "attachments", "about 11 MB, over the upload limit"), "scanned archive");

  return { files, queues, shared, secondary, oversized };
}

// A small anti-aliased raster for the demo pictures: filled polygons with
// exact horizontal coverage on sixteen sub-scanlines per pixel, strokes built
// from polygons, and text drawn from the DejaVu glyph atlas. Pure code, so the
// same drawing gives the same bytes on every machine.

import { inflateSync } from "node:zlib";
import { encodePng } from "../corpus/binary/png.ts";
import { ATLAS, type AtlasFont } from "./font/dejavu-atlas.ts";

export type Rgb = readonly [number, number, number];
export type Point = readonly [number, number];
export type FontName = "regular" | "bold" | "title";

export function hex(value: string): Rgb {
  const n = Number.parseInt(value.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

type Glyph = { advance: number; left: number; top: number; width: number; height: number; offset: number };
type LoadedFont = { size: number; ascent: number; descent: number; glyphs: Map<number, Glyph>; alpha: Buffer };

const loaded = new Map<FontName, LoadedFont>();

function font(name: FontName): LoadedFont {
  const cached = loaded.get(name);
  if (cached) return cached;
  const atlas = ATLAS[name] as AtlasFont;
  const glyphs = new Map<number, Glyph>();
  let offset = 0;
  for (const [ch, advance, left, top, width, height] of atlas.glyphs as number[][]) {
    glyphs.set(ch!, { advance: advance!, left: left!, top: top!, width: width!, height: height!, offset });
    offset += width! * height!;
  }
  const result = { size: atlas.size, ascent: atlas.ascent, descent: atlas.descent, glyphs, alpha: inflateSync(Buffer.from(atlas.alpha, "base64")) };
  loaded.set(name, result);
  return result;
}

const SUB = 16;

export class Raster {
  readonly width: number;
  readonly height: number;
  private readonly data: Float32Array;

  constructor(width: number, height: number, background: Rgb) {
    this.width = width;
    this.height = height;
    this.data = new Float32Array(width * height * 3);
    // Paint one pixel, then double the painted run until the canvas is full.
    this.data.set(background, 0);
    for (let filled = 3; filled < this.data.length; filled *= 2) this.data.copyWithin(filled, 0, Math.min(filled, this.data.length - filled));
  }

  private blend(x: number, y: number, c: Rgb, alpha: number): void {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const a = Math.min(1, alpha);
    const i = (y * this.width + x) * 3;
    for (let k = 0; k < 3; k++) this.data[i + k] = this.data[i + k]! * (1 - a) + c[k]! * a;
  }

  /**
   * Fills a polygon (non-zero winding) with anti-aliased edges. `columns`
   * limits the fill to the pixel columns [from, to), so a shape can be
   * filled in parts that meet on whole-pixel seams.
   */
  fill(points: readonly Point[], c: Rgb, opacity = 1, columns: readonly [number, number] = [0, this.width]): void {
    if (points.length < 3) return;
    const ys = points.map((p) => p[1]);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(this.height - 1, Math.ceil(Math.max(...ys)));
    const xs = points.map((p) => p[0]);
    const xMin = Math.max(0, columns[0], Math.floor(Math.min(...xs)));
    const xMax = Math.min(this.width - 1, columns[1] - 1, Math.ceil(Math.max(...xs)));
    if (xMax < xMin) return;
    const span = xMax - xMin + 2;
    const cover = new Float64Array(span);
    for (let y = y0; y <= y1; y++) {
      cover.fill(0);
      for (let s = 0; s < SUB; s++) {
        const sy = y + (s + 0.5) / SUB;
        const crossings: { x: number; dir: number }[] = [];
        for (let i = 0; i < points.length; i++) {
          const a = points[i]!;
          const b = points[(i + 1) % points.length]!;
          if (a[1] === b[1]) continue;
          const lo = a[1] < b[1] ? a : b;
          const hi = a[1] < b[1] ? b : a;
          if (sy < lo[1] || sy >= hi[1]) continue;
          crossings.push({ x: lo[0] + ((sy - lo[1]) / (hi[1] - lo[1])) * (hi[0] - lo[0]), dir: a[1] < b[1] ? 1 : -1 });
        }
        crossings.sort((p, q) => p.x - q.x);
        let winding = 0;
        for (let i = 0; i < crossings.length - 1; i++) {
          winding += crossings[i]!.dir;
          if (winding === 0) continue;
          const xa = Math.max(xMin, crossings[i]!.x);
          const xb = Math.min(xMax + 1, crossings[i + 1]!.x);
          if (xb <= xa) continue;
          const ia = Math.floor(xa);
          const ib = Math.floor(xb);
          if (ia === ib) {
            cover[ia - xMin]! += (xb - xa) / SUB;
          } else {
            cover[ia - xMin]! += (ia + 1 - xa) / SUB;
            for (let x = ia + 1; x < ib; x++) cover[x - xMin]! += 1 / SUB;
            if (ib - xMin < span) cover[ib - xMin]! += (xb - ib) / SUB;
          }
        }
      }
      for (let x = xMin; x <= xMax; x++) this.blend(x, y, c, cover[x - xMin]! * opacity);
    }
  }

  /** An axis-aligned rectangle, with each edge pixel covered by the exact overlapping area. */
  rect(x: number, y: number, w: number, h: number, c: Rgb, opacity = 1): void {
    if (w <= 0 || h <= 0) return;
    const x1 = x + w;
    const y1 = y + h;
    for (let py = Math.max(0, Math.floor(y)); py < Math.min(this.height, Math.ceil(y1)); py++) {
      const cy = Math.min(py + 1, y1) - Math.max(py, y);
      for (let px = Math.max(0, Math.floor(x)); px < Math.min(this.width, Math.ceil(x1)); px++) {
        this.blend(px, py, c, (Math.min(px + 1, x1) - Math.max(px, x)) * cy * opacity);
      }
    }
  }

  /** A rectangle with rounded corners; `corners` picks which: top-left, top-right, bottom-right, bottom-left. */
  roundRect(x: number, y: number, w: number, h: number, r: number, c: Rgb, corners: readonly [boolean, boolean, boolean, boolean] = [true, true, true, true], opacity = 1): void {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    const pts: Point[] = [];
    const arc = (cx: number, cy: number, from: number, round: boolean, px: number, py: number) => {
      if (!round || rr === 0) {
        pts.push([px, py]);
        return;
      }
      for (let i = 0; i <= 8; i++) {
        const t = from + (i / 8) * (Math.PI / 2);
        pts.push([cx + rr * Math.cos(t), cy + rr * Math.sin(t)]);
      }
    };
    arc(x + rr, y + rr, Math.PI, corners[0], x, y);
    arc(x + w - rr, y + rr, -Math.PI / 2, corners[1], x + w, y);
    arc(x + w - rr, y + h - rr, 0, corners[2], x + w, y + h);
    arc(x + rr, y + h - rr, Math.PI / 2, corners[3], x, y + h);
    // Between the corners the shape is a plain rectangle: fill it directly and
    // only the two strips with the corners as polygons, meeting on whole pixels.
    const left = Math.ceil(x + rr);
    const right = Math.floor(x + w - rr);
    if (right <= left) {
      this.fill(pts, c, opacity);
      return;
    }
    this.rect(left, y, right - left, h, c, opacity);
    this.fill(pts, c, opacity, [Math.floor(x), left]);
    this.fill(pts, c, opacity, [right, Math.ceil(x + w)]);
  }

  circle(cx: number, cy: number, r: number, c: Rgb): void {
    const pts: Point[] = [];
    const n = Math.max(16, Math.ceil(r * 4));
    for (let i = 0; i < n; i++) pts.push([cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)]);
    this.fill(pts, c);
  }

  line(a: Point, b: Point, c: Rgb, width: number): void {
    if (a[1] === b[1]) return this.rect(Math.min(a[0], b[0]), a[1] - width / 2, Math.abs(b[0] - a[0]), width, c);
    if (a[0] === b[0]) return this.rect(a[0] - width / 2, Math.min(a[1], b[1]), width, Math.abs(b[1] - a[1]), c);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    const nx = (-dy / len) * (width / 2);
    const ny = (dx / len) * (width / 2);
    this.fill([[a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny], [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny]], c);
  }

  /** A stroked path as one polygon outline per segment, with round joins. */
  polyline(points: readonly Point[], c: Rgb, width: number): void {
    for (let i = 0; i < points.length - 1; i++) this.line(points[i]!, points[i + 1]!, c, width);
    for (let i = 1; i < points.length - 1; i++) this.circle(points[i]![0], points[i]![1], width / 2, c);
  }

  dashed(a: Point, b: Point, c: Rgb, width: number, dash: number): void {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let d = 0; d < len; d += dash * 2) {
      const t0 = d / len;
      const t1 = Math.min(1, (d + dash) / len);
      this.line([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1], c, width);
    }
  }

  arrow(a: Point, b: Point, c: Rgb, width: number, head: number): void {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) return;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    const base: Point = [b[0] - ux * head, b[1] - uy * head];
    this.line(a, base, c, width);
    this.fill([b, [base[0] - uy * head * 0.55, base[1] + ux * head * 0.55], [base[0] + uy * head * 0.55, base[1] - ux * head * 0.55]], c);
  }

  /** Width of a text in pixels. */
  measure(text: string, name: FontName): number {
    const f = font(name);
    let w = 0;
    for (const ch of text) w += (f.glyphs.get(ch.codePointAt(0)!) ?? f.glyphs.get(63)!).advance;
    return w;
  }

  /** Draws text with its baseline at y. Returns the width. */
  text(x: number, y: number, text: string, c: Rgb, name: FontName, align: "left" | "center" | "right" = "left"): number {
    const f = font(name);
    const width = this.measure(text, name);
    let pen = align === "left" ? x : align === "center" ? x - width / 2 : x - width;
    for (const ch of text) {
      const g = f.glyphs.get(ch.codePointAt(0)!) ?? f.glyphs.get(63)!;
      const gx = Math.round(pen) + g.left;
      const gy = Math.round(y) + g.top;
      for (let j = 0; j < g.height; j++) {
        for (let i = 0; i < g.width; i++) this.blend(gx + i, gy + j, c, f.alpha[g.offset + j * g.width + i]! / 255);
      }
      pen += g.advance;
    }
    return width;
  }

  /** Font metrics: ascent and descent in pixels. */
  metrics(name: FontName): { ascent: number; descent: number } {
    const f = font(name);
    return { ascent: f.ascent, descent: f.descent };
  }

  png(): Buffer {
    // Uint8ClampedArray clamps to 0..255 and rounds to the nearest integer.
    const out = Buffer.from(new Uint8ClampedArray(this.data).buffer);
    return encodePng({ width: this.width, height: this.height, channels: 3, data: out }, { level: 6 });
  }
}

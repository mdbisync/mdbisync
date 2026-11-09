// A small raster canvas for the corpus's pictures: filled shapes, thick
// lines, gradients and a 5x7 bitmap font. No anti-aliasing; pictures are
// flat UI and chart shapes, which compress well and look clean.

import type { Pixels } from "./png.ts";

export type Rgb = readonly [number, number, number];

// 5x7 glyphs, one number per row, bit 4 is the leftmost column.
const GLYPHS: Record<string, readonly number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [31, 2, 4, 2, 1, 17, 14], "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8], "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12],
  " ": [0, 0, 0, 0, 0, 0, 0], ".": [0, 0, 0, 0, 0, 12, 12], ",": [0, 0, 0, 0, 12, 4, 8],
  ":": [0, 12, 12, 0, 12, 12, 0], "%": [24, 25, 2, 4, 8, 19, 3], "-": [0, 0, 0, 31, 0, 0, 0],
  "/": [0, 1, 2, 4, 8, 16, 0], "+": [0, 4, 4, 31, 4, 4, 0], "(": [2, 4, 8, 8, 8, 4, 2],
  ")": [8, 4, 2, 2, 2, 4, 8], "#": [10, 10, 31, 10, 31, 10, 10], ">": [8, 4, 2, 1, 2, 4, 8],
  "&": [12, 18, 20, 8, 21, 18, 13], "'": [4, 4, 8, 0, 0, 0, 0],
};

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.max(0, Math.min(1, t));
  return [Math.round(a[0] + (b[0] - a[0]) * k), Math.round(a[1] + (b[1] - a[1]) * k), Math.round(a[2] + (b[2] - a[2]) * k)];
}

export class Canvas {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number, background: Rgb) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 3);
    this.rect(0, 0, width, height, background);
  }

  set(x: number, y: number, c: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
  }

  get(x: number, y: number): Rgb {
    const i = (y * this.width + x) * 3;
    return [this.data[i] as number, this.data[i + 1] as number, this.data[i + 2] as number];
  }

  rect(x: number, y: number, w: number, h: number, c: Rgb): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    if (x1 <= x0 || y1 <= y0) return;
    // Fill the first row pixel by pixel, then copy it to the rows below.
    const start = (y0 * this.width + x0) * 3;
    for (let xx = x0; xx < x1; xx++) this.set(xx, y0, c);
    for (let yy = y0 + 1; yy < y1; yy++) this.data.copy(this.data, (yy * this.width + x0) * 3, start, start + (x1 - x0) * 3);
  }

  roundRect(x: number, y: number, w: number, h: number, r: number, c: Rgb): void {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    for (let yy = Math.max(0, Math.round(y)); yy < Math.min(this.height, Math.round(y + h)); yy++) {
      for (let xx = Math.max(0, Math.round(x)); xx < Math.min(this.width, Math.round(x + w)); xx++) {
        const dx = Math.max(x + rr - xx - 0.5, 0, xx + 0.5 - (x + w - rr));
        const dy = Math.max(y + rr - yy - 0.5, 0, yy + 0.5 - (y + h - rr));
        if (dx * dx + dy * dy <= rr * rr) this.set(xx, yy, c);
      }
    }
  }

  circle(cx: number, cy: number, r: number, c: Rgb): void {
    for (let yy = Math.floor(cy - r); yy <= Math.ceil(cy + r); yy++) {
      for (let xx = Math.floor(cx - r); xx <= Math.ceil(cx + r); xx++) {
        if ((xx - cx) ** 2 + (yy - cy) ** 2 <= r * r) this.set(xx, yy, c);
      }
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, c: Rgb, thickness = 1): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    const half = thickness / 2;
    for (let s = 0; s <= steps; s++) {
      const x = x0 + ((x1 - x0) * s) / steps;
      const y = y0 + ((y1 - y0) * s) / steps;
      if (thickness <= 1.5) this.set(Math.round(x), Math.round(y), c);
      else this.circle(x, y, half, c);
    }
  }

  polyline(points: readonly (readonly [number, number])[], c: Rgb, thickness = 1): void {
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1] as readonly [number, number], points[i] as readonly [number, number]];
      this.line(a[0], a[1], b[0], b[1], c, thickness);
    }
  }

  /** An arrow from (x0, y0) to (x1, y1) with a filled head. */
  arrow(x0: number, y0: number, x1: number, y1: number, c: Rgb, thickness: number): void {
    const angle = Math.atan2(y1 - y0, x1 - x0);
    const head = Math.max(4, thickness * 4);
    this.line(x0, y0, x1 - Math.cos(angle) * head * 0.8, y1 - Math.sin(angle) * head * 0.8, c, thickness);
    const left = [x1 - head * Math.cos(angle - 0.45), y1 - head * Math.sin(angle - 0.45)] as const;
    const right = [x1 - head * Math.cos(angle + 0.45), y1 - head * Math.sin(angle + 0.45)] as const;
    this.triangle([x1, y1], left, right, c);
  }

  triangle(a: readonly [number, number], b: readonly [number, number], d: readonly [number, number], c: Rgb): void {
    const minX = Math.floor(Math.min(a[0], b[0], d[0]));
    const maxX = Math.ceil(Math.max(a[0], b[0], d[0]));
    const minY = Math.floor(Math.min(a[1], b[1], d[1]));
    const maxY = Math.ceil(Math.max(a[1], b[1], d[1]));
    const edge = (p: readonly [number, number], q: readonly [number, number], x: number, y: number) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const e1 = edge(a, b, x, y);
        const e2 = edge(b, d, x, y);
        const e3 = edge(d, a, x, y);
        if ((e1 >= 0 && e2 >= 0 && e3 >= 0) || (e1 <= 0 && e2 <= 0 && e3 <= 0)) this.set(x, y, c);
      }
    }
  }

  verticalGradient(x: number, y: number, w: number, h: number, top: Rgb, bottom: Rgb): void {
    for (let yy = 0; yy < h; yy++) this.rect(x, y + yy, w, 1, mix(top, bottom, yy / Math.max(1, h - 1)));
  }

  /** Draws text in the bitmap font; returns the width drawn. Lowercase is drawn as uppercase. */
  text(x: number, y: number, text: string, c: Rgb, scale = 1): number {
    let cx = Math.round(x);
    for (const ch of text.toUpperCase()) {
      const glyph = GLYPHS[ch] ?? GLYPHS[" "];
      (glyph as readonly number[]).forEach((row, gy) => {
        for (let gx = 0; gx < 5; gx++) if (row & (16 >> gx)) this.rect(cx + gx * scale, Math.round(y) + gy * scale, scale, scale, c);
      });
      cx += 6 * scale;
    }
    return cx - Math.round(x);
  }

  pixels(channels: 3 | 4 = 3): Pixels {
    if (channels === 3) return { width: this.width, height: this.height, channels, data: Buffer.from(this.data) };
    const data = Buffer.alloc(this.width * this.height * 4);
    for (let i = 0, j = 0; i < this.data.length; i += 3, j += 4) {
      data[j] = this.data[i] as number;
      data[j + 1] = this.data[i + 1] as number;
      data[j + 2] = this.data[i + 2] as number;
      data[j + 3] = 255;
    }
    return { width: this.width, height: this.height, channels, data };
  }
}

export function textWidth(text: string, scale = 1): number {
  return text.length * 6 * scale - scale;
}

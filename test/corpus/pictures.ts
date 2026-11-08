// The corpus's pictures: app screenshots, charts, diagrams, route maps,
// landscape photos and icons, drawn by code from the seed. Raster scenes
// draw on a Canvas; SVG scenes write vector markup with real text.

import { Canvas, mix, textWidth, type Rgb } from "./binary/draw.ts";
import type { Rng } from "./rng.ts";

export const INK: Rgb = [31, 41, 55];
const MUTED: Rgb = [107, 114, 128];
const LINE: Rgb = [229, 231, 235];
const PAPER: Rgb = [249, 250, 251];
const WHITE: Rgb = [255, 255, 255];
const SIDEBAR: Rgb = [17, 24, 39];
export const ACCENTS: readonly Rgb[] = [
  [37, 99, 235], // blue
  [13, 148, 136], // teal
  [124, 58, 237], // violet
  [234, 88, 12], // orange
  [22, 163, 74], // green
  [219, 39, 119], // pink
];
const STATUS: readonly Rgb[] = [[22, 163, 74], [245, 158, 11], [220, 38, 38], [37, 99, 235]];

export type Scene = "screenshot" | "phone" | "bar-chart" | "line-chart" | "donut-chart" | "diagram" | "map" | "photo" | "icon";

/** What a picture shows; the documents use the title in alt text and captions. */
export type PictureSpec = {
  scene: Scene;
  /** Upper-case words drawn in the picture, such as a page or chart title. */
  title: string;
  /** Short labels: navigation items, chart categories or diagram boxes. */
  labels: readonly string[];
  accent: Rgb;
  /** 0..1, for animation frames: how far bars have grown or a cursor has moved. */
  progress?: number;
};

function scaleFor(height: number): number {
  return Math.max(1, Math.round(height / 240));
}

// ---------------------------------------------------------------- screenshots

function windowChrome(c: Canvas, s: number): number {
  const bar = 10 * s;
  c.rect(0, 0, c.width, bar, [229, 231, 235]);
  STATUS.slice(0, 3).reverse().forEach((color, i) => c.circle(6 * s + i * 7 * s, bar / 2, 2.2 * s, i === 0 ? [239, 68, 68] : i === 1 ? [245, 158, 11] : [34, 197, 94]));
  c.roundRect(c.width * 0.3, 2 * s, c.width * 0.4, bar - 4 * s, 2 * s, WHITE);
  return bar;
}

function textBar(c: Canvas, x: number, y: number, w: number, s: number, color: Rgb): void {
  c.roundRect(x, y, Math.max(2 * s, w), 3 * s, 1.5 * s, color);
}

export function drawScreenshot(c: Canvas, rng: Rng, spec: PictureSpec): void {
  const s = scaleFor(c.height);
  const top = windowChrome(c, s);
  const side = Math.round(c.width * 0.17);
  c.rect(0, top, side, c.height - top, SIDEBAR);
  c.roundRect(6 * s, top + 6 * s, 8 * s, 8 * s, 2 * s, spec.accent);
  c.text(17 * s, top + 7 * s, "KITEWING", WHITE, Math.max(1, Math.floor(s * 0.8)));
  const active = Math.floor((spec.progress ?? rng.next()) * spec.labels.length) % Math.max(1, spec.labels.length);
  spec.labels.forEach((label, i) => {
    const y = top + 24 * s + i * 13 * s;
    if (i === active) c.roundRect(3 * s, y - 3 * s, side - 6 * s, 11 * s, 2 * s, mix(SIDEBAR, spec.accent, 0.55));
    c.roundRect(7 * s, y, 4 * s, 4 * s, 1 * s, i === active ? WHITE : [75, 85, 99]);
    c.text(14 * s, y - 1 * s, label.slice(0, Math.max(3, Math.floor((side - 16 * s) / (6 * s)))), i === active ? WHITE : [156, 163, 175], s);
  });
  // Header with the page title and a primary button.
  const x0 = side + 10 * s;
  const contentWidth = c.width - x0 - 10 * s;
  c.rect(side, top, c.width - side, 22 * s, WHITE);
  c.rect(side, top + 22 * s, c.width - side, 1 * s, LINE);
  c.text(x0, top + 8 * s, spec.title, INK, s);
  const button = textWidth("NEW", s) + 10 * s;
  c.roundRect(c.width - 10 * s - button, top + 5 * s, button, 12 * s, 3 * s, spec.accent);
  c.text(c.width - 5 * s - button, top + 8 * s, "NEW", WHITE, s);

  const y0 = top + 30 * s;
  const layout = rng.int(0, 2);
  if (layout === 0) {
    // KPI cards and a table.
    const cards = 4;
    const gap = 6 * s;
    const cw = (contentWidth - gap * (cards - 1)) / cards;
    for (let i = 0; i < cards; i++) {
      const x = x0 + i * (cw + gap);
      c.roundRect(x, y0, cw, 30 * s, 3 * s, WHITE);
      c.text(x + 5 * s, y0 + 5 * s, (spec.labels[i] ?? "TOTAL").slice(0, 8), MUTED, Math.max(1, Math.floor(s * 0.8)));
      c.text(x + 5 * s, y0 + 15 * s, String(rng.int(12, 980)) + (i % 2 === 0 ? "" : "%"), INK, s * 2);
    }
    tableRows(c, rng, x0, y0 + 38 * s, contentWidth, c.height - (y0 + 38 * s) - 8 * s, s, spec.accent);
  } else if (layout === 1) {
    // A route map with a list beside it.
    const mapWidth = Math.round(contentWidth * 0.62);
    const mapHeight = c.height - y0 - 8 * s;
    const map = new Canvas(Math.max(1, mapWidth), Math.max(1, mapHeight), [241, 238, 232]);
    drawMap(map, rng, spec, s);
    for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) c.set(x0 + x, y0 + y, map.get(x, y));
    const lx = x0 + mapWidth + 8 * s;
    const lw = contentWidth - mapWidth - 8 * s;
    for (let i = 0; y0 + i * 18 * s + 14 * s < c.height - 8 * s; i++) {
      const y = y0 + i * 18 * s;
      c.roundRect(lx, y, lw, 14 * s, 3 * s, WHITE);
      c.circle(lx + 7 * s, y + 7 * s, 3 * s, STATUS[i % STATUS.length] as Rgb);
      textBar(c, lx + 13 * s, y + 3 * s, lw * rng.int(40, 75) / 100, s, [156, 163, 175]);
      textBar(c, lx + 13 * s, y + 8 * s, lw * rng.int(20, 45) / 100, s, LINE);
    }
  } else {
    // A board with columns of cards.
    const columns = 4;
    const gap = 6 * s;
    const cw = (contentWidth - gap * (columns - 1)) / columns;
    for (let i = 0; i < columns; i++) {
      const x = x0 + i * (cw + gap);
      c.roundRect(x, y0, cw, c.height - y0 - 8 * s, 3 * s, [243, 244, 246]);
      c.text(x + 5 * s, y0 + 5 * s, (spec.labels[i] ?? "LANE").slice(0, Math.max(3, Math.floor(cw / (6 * s)) - 2)), MUTED, s);
      for (let k = 0, y = y0 + 16 * s; k < rng.int(1, 5) && y + 22 * s < c.height - 10 * s; k++, y += 26 * s) {
        c.roundRect(x + 3 * s, y, cw - 6 * s, 22 * s, 2 * s, WHITE);
        c.rect(x + 3 * s, y, 1.5 * s, 22 * s, STATUS[(i + k) % STATUS.length] as Rgb);
        textBar(c, x + 7 * s, y + 5 * s, (cw - 14 * s) * rng.int(50, 95) / 100, s, [156, 163, 175]);
        textBar(c, x + 7 * s, y + 11 * s, (cw - 14 * s) * rng.int(25, 60) / 100, s, LINE);
        c.circle(x + cw - 10 * s, y + 16 * s, 2.5 * s, ACCENTS[(i * 3 + k) % ACCENTS.length] as Rgb);
      }
    }
  }
}

function tableRows(c: Canvas, rng: Rng, x: number, y: number, w: number, h: number, s: number, accent: Rgb): void {
  c.roundRect(x, y, w, h, 3 * s, WHITE);
  const row = 12 * s;
  c.rect(x, y + row, w, 1 * s, LINE);
  const cols = [0.04, 0.3, 0.55, 0.78];
  cols.forEach((cx) => textBar(c, x + w * cx, y + 4.5 * s, w * 0.12, s, MUTED));
  for (let i = 1; (i + 1) * row < h; i++) {
    const ry = y + i * row;
    if (i % 2 === 0) c.rect(x, ry + 1 * s, w, row - 1 * s, PAPER);
    textBar(c, x + w * cols[0]!, ry + 4.5 * s, w * rng.int(10, 22) / 100, s, [156, 163, 175]);
    textBar(c, x + w * cols[1]!, ry + 4.5 * s, w * rng.int(8, 18) / 100, s, LINE);
    const status = STATUS[rng.int(0, STATUS.length - 1)] as Rgb;
    c.roundRect(x + w * cols[2]!, ry + 3 * s, 22 * s, 6 * s, 3 * s, mix(status, WHITE, 0.75));
    c.circle(x + w * cols[2]! + 4 * s, ry + 6 * s, 1.5 * s, status);
    const bar = w * 0.16;
    c.roundRect(x + w * cols[3]!, ry + 4.5 * s, bar, 3 * s, 1.5 * s, LINE);
    c.roundRect(x + w * cols[3]!, ry + 4.5 * s, bar * rng.int(10, 100) / 100, 3 * s, 1.5 * s, accent);
  }
}

/** A phone screen: a list of delivery stops with a bottom bar. */
export function drawPhone(c: Canvas, rng: Rng, spec: PictureSpec): void {
  const s = Math.max(1, Math.floor(c.width / 130));
  const bezel = 6 * s;
  c.roundRect(0, 0, c.width, c.height, 18 * s, [17, 17, 17]);
  const sx = bezel;
  const sy = bezel;
  const sw = c.width - 2 * bezel;
  const sh = c.height - 2 * bezel;
  c.roundRect(sx, sy, sw, sh, 13 * s, PAPER);
  c.roundRect(c.width / 2 - 18 * s, sy + 3 * s, 36 * s, 7 * s, 3.5 * s, [17, 17, 17]);
  c.rect(sx, sy + 14 * s, sw, 26 * s, spec.accent);
  c.text(sx + 8 * s, sy + 24 * s, spec.title.slice(0, Math.floor((sw - 16 * s) / (6 * s))), WHITE, s);
  let y = sy + 46 * s;
  for (let i = 0; y + 30 * s < sy + sh - 30 * s; i++, y += 34 * s) {
    c.roundRect(sx + 6 * s, y, sw - 12 * s, 30 * s, 4 * s, WHITE);
    const done = i < Math.round((spec.progress ?? 0.4) * 6);
    c.circle(sx + 18 * s, y + 15 * s, 7 * s, done ? (STATUS[0] as Rgb) : mix(spec.accent, WHITE, 0.7));
    c.text(sx + 16 * s, y + 12 * s, String(i + 1), done ? WHITE : spec.accent, s);
    c.text(sx + 30 * s, y + 7 * s, (spec.labels[i % spec.labels.length] ?? "STOP").slice(0, Math.floor((sw - 44 * s) / (6 * s))), INK, s);
    textBar(c, sx + 30 * s, y + 18 * s, (sw - 50 * s) * rng.int(40, 90) / 100, s, LINE);
  }
  c.rect(sx, sy + sh - 26 * s, sw, 1 * s, LINE);
  for (let i = 0; i < 4; i++) c.roundRect(sx + (sw / 4) * i + sw / 8 - 5 * s, sy + sh - 19 * s, 10 * s, 10 * s, 3 * s, i === 0 ? spec.accent : [209, 213, 219]);
}

// ---------------------------------------------------------------- charts

function chartFrame(c: Canvas, spec: PictureSpec, s: number): { x: number; y: number; w: number; h: number } {
  c.text(10 * s, 8 * s, spec.title, INK, s);
  const x = 30 * s;
  const y = 26 * s;
  const w = c.width - x - 12 * s;
  const h = c.height - y - 20 * s;
  for (let i = 0; i <= 4; i++) {
    const gy = y + (h * i) / 4;
    c.rect(x, gy, w, Math.max(1, Math.floor(s / 2)), LINE);
    c.text(4 * s, gy - 3 * s, String((4 - i) * 25), MUTED, s);
  }
  return { x, y, w, h };
}

export function drawBarChart(c: Canvas, rng: Rng, spec: PictureSpec): void {
  const s = scaleFor(c.height);
  const { x, y, w, h } = chartFrame(c, spec, s);
  const n = spec.labels.length;
  const slot = w / n;
  const growth = spec.progress ?? 1;
  spec.labels.forEach((label, i) => {
    const value = rng.int(28, 96) / 100;
    const bh = h * value * growth;
    const bx = x + i * slot + slot * 0.18;
    c.roundRect(bx, y + h - bh, slot * 0.64, bh, 2 * s, i === n - 1 ? mix(spec.accent, INK, 0.25) : spec.accent);
    c.text(x + i * slot + slot / 2 - textWidth(label.slice(0, 4), s) / 2, y + h + 6 * s, label.slice(0, 4), MUTED, s);
  });
}

export function drawLineChart(c: Canvas, rng: Rng, spec: PictureSpec): void {
  const s = scaleFor(c.height);
  const { x, y, w, h } = chartFrame(c, spec, s);
  const n = spec.labels.length;
  const series = [spec.accent, mix(spec.accent, [156, 163, 175], 0.7)];
  series.forEach((color, k) => {
    let v = rng.int(30, 70) / 100;
    const points: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      v = Math.max(0.08, Math.min(0.95, v + (rng.next() - 0.45) * 0.18 - k * 0.02));
      points.push([x + (w * i) / Math.max(1, n - 1), y + h - h * v]);
    }
    const shown = points.slice(0, Math.max(2, Math.ceil(points.length * (spec.progress ?? 1))));
    c.polyline(shown, color, k === 0 ? 2.5 * s : 1.5 * s);
    if (k === 0) for (const [px, py] of shown) c.circle(px, py, 2.5 * s, color);
  });
  spec.labels.forEach((label, i) => {
    if (i % Math.ceil(n / 8) === 0) c.text(x + (w * i) / Math.max(1, n - 1) - 6 * s, y + h + 6 * s, label.slice(0, 3), MUTED, s);
  });
}

export function drawDonutChart(c: Canvas, rng: Rng, spec: PictureSpec): void {
  const s = scaleFor(c.height);
  c.text(10 * s, 8 * s, spec.title, INK, s);
  const r = Math.min(c.width * 0.28, (c.height - 30 * s) * 0.45);
  const cx = r + 20 * s;
  const cy = 24 * s + (c.height - 24 * s) / 2;
  const values = spec.labels.map(() => rng.int(10, 40));
  const total = values.reduce((a, b) => a + b, 0);
  const stops: number[] = [];
  values.reduce((acc, v) => {
    stops.push((acc + v) / total);
    return acc + v;
  }, 0);
  for (let yy = Math.floor(cy - r); yy <= cy + r; yy++) {
    for (let xx = Math.floor(cx - r); xx <= cx + r; xx++) {
      const d = Math.hypot(xx - cx, yy - cy);
      if (d > r || d < r * 0.58) continue;
      const turn = (Math.atan2(yy - cy, xx - cx) / (2 * Math.PI) + 1.25) % 1;
      const k = stops.findIndex((stop) => turn <= stop);
      c.set(xx, yy, ACCENTS[(k + ACCENTS.indexOf(spec.accent) + ACCENTS.length) % ACCENTS.length] as Rgb);
    }
  }
  const pct = String(Math.round(((values[0] as number) * 100) / total)) + "%";
  c.text(cx - textWidth(pct, s * 2) / 2, cy - 7 * s, pct, INK, s * 2);
  spec.labels.forEach((label, i) => {
    const ly = 34 * s + i * 14 * s;
    const lx = cx + r + 20 * s;
    c.roundRect(lx, ly, 7 * s, 7 * s, 1.5 * s, ACCENTS[(i + ACCENTS.indexOf(spec.accent) + ACCENTS.length) % ACCENTS.length] as Rgb);
    c.text(lx + 11 * s, ly, `${label} ${Math.round(((values[i] as number) * 100) / total)}%`, INK, s);
  });
}

// ---------------------------------------------------------------- diagrams and maps

export function drawDiagram(c: Canvas, rng: Rng, spec: PictureSpec): void {
  const s = scaleFor(c.height);
  for (let y = 6 * s; y < c.height; y += 10 * s) for (let x = 6 * s; x < c.width; x += 10 * s) c.rect(x, y, s, s, LINE);
  c.text(10 * s, 8 * s, spec.title, INK, s);
  const labels = spec.labels;
  const rows = labels.length > 4 ? 2 : 1;
  const perRow = Math.ceil(labels.length / rows);
  const boxW = Math.min(80 * s, (c.width - 20 * s) / perRow - 16 * s) * (0.8 + rng.int(0, 20) / 100);
  // Each row sits a seeded few pixels up or down, so no two diagrams are the same file.
  const rowShift = [rng.int(-8, 8), rng.int(-8, 8)];
  const boxH = 22 * s;
  const centers: [number, number][] = [];
  labels.forEach((label, i) => {
    const row = Math.floor(i / perRow);
    const col = row % 2 === 0 ? i % perRow : perRow - 1 - (i % perRow);
    const cx = 10 * s + ((c.width - 20 * s) / perRow) * (col + 0.5);
    const cy = 28 * s + ((c.height - 36 * s) / rows) * (row + 0.5) + (rowShift[row] as number) * s;
    centers.push([cx, cy]);
    const color = ACCENTS[(i + rng.int(0, 1)) % ACCENTS.length] as Rgb;
    c.roundRect(cx - boxW / 2 + s, cy - boxH / 2 + 2 * s, boxW, boxH, 4 * s, LINE);
    c.roundRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH, 4 * s, mix(color, WHITE, 0.85));
    c.rect(cx - boxW / 2, cy - boxH / 2 + 3 * s, 2 * s, boxH - 6 * s, color);
    const fit = label.slice(0, Math.max(2, Math.floor((boxW - 8 * s) / (6 * s))));
    c.text(cx - textWidth(fit, s) / 2, cy - 3 * s, fit, INK, s);
  });
  for (let i = 1; i < centers.length; i++) {
    const [ax, ay] = centers[i - 1] as [number, number];
    const [bx, by] = centers[i] as [number, number];
    if (Math.abs(ay - by) < 1) {
      const dir = Math.sign(bx - ax);
      c.arrow(ax + (dir * boxW) / 2, ay, bx - (dir * boxW) / 2 - dir * s, by, MUTED, Math.max(1, s));
    } else {
      c.arrow(ax, ay + boxH / 2, bx, by - boxH / 2 - s, MUTED, Math.max(1, s));
    }
  }
}

export function drawMap(c: Canvas, rng: Rng, spec: PictureSpec, scale?: number): void {
  const s = scale ?? scaleFor(c.height);
  c.rect(0, 0, c.width, c.height, [241, 238, 232]);
  // Water along one side and a few parks.
  const shore = c.width * (0.75 + rng.next() * 0.15);
  for (let y = 0; y < c.height; y++) {
    const edge = shore + Math.sin(y / (18 * s)) * 6 * s;
    c.rect(edge, y, c.width - edge, 1, [170, 211, 223]);
  }
  for (let i = 0; i < 4; i++) c.circle(rng.int(0, Math.floor(shore)), rng.int(0, c.height), rng.int(8, 22) * s, [200, 225, 190]);
  // Streets: a grid with a couple of arterials.
  const step = 24 * s;
  for (let x = step / 2; x < shore; x += step) c.rect(x, 0, 2 * s, c.height, WHITE);
  for (let y = step / 2; y < c.height; y += step) c.rect(0, y, shore, 2 * s, WHITE);
  c.rect(0, c.height * 0.4, shore, 4 * s, [253, 230, 138]);
  c.rect(c.width * 0.35, 0, 4 * s, c.height, [253, 230, 138]);
  // A route along the grid with numbered stops.
  const cols = Math.max(2, Math.floor(shore / step));
  const rows = Math.max(2, Math.floor(c.height / step));
  let gx = rng.int(0, Math.max(0, Math.floor(cols / 4)));
  let gy = rng.int(1, rows - 2);
  const points: [number, number][] = [[step / 2 + gx * step + s, step / 2 + gy * step + s]];
  const stops = Math.max(3, Math.min(9, spec.labels.length + 2));
  for (let i = 0; i < stops * 2; i++) {
    if (i % 2 === 0) gx = Math.max(0, Math.min(cols - 1, gx + rng.int(1, Math.max(1, Math.floor(cols / stops))) * (rng.bool(0.85) ? 1 : -1)));
    else gy = Math.max(0, Math.min(rows - 1, gy + rng.int(-3, 3)));
    points.push([step / 2 + gx * step + s, step / 2 + gy * step + s]);
  }
  c.polyline(points, mix(spec.accent, INK, 0.2), 4 * s);
  c.polyline(points, spec.accent, 2.5 * s);
  points.filter((_, i) => i % 2 === 0).forEach(([px, py], i) => {
    c.circle(px, py, 6 * s, WHITE);
    c.circle(px, py, 4.5 * s, i === 0 ? INK : spec.accent);
    if (i < 9) c.text(px - 2 * s, py - 3 * s, String(i + 1), WHITE, s);
  });
}

// ---------------------------------------------------------------- photos and icons

/** A landscape: sky, sun, layered hills and, sometimes, a lake reflection. */
export function drawPhoto(c: Canvas, rng: Rng): void {
  const palettes: [Rgb, Rgb, Rgb][] = [
    [[255, 183, 130], [104, 109, 224], [52, 45, 113]], // dusk
    [[173, 216, 255], [255, 244, 214], [46, 94, 78]], // morning
    [[255, 214, 165], [255, 140, 120], [92, 60, 90]], // sunset
    [[200, 230, 250], [140, 190, 230], [60, 96, 120]], // winter
  ];
  const [sky0, sky1, land] = rng.pick(palettes);
  const horizon = c.height * (0.5 + rng.next() * 0.15);
  const lake = rng.bool(0.5);
  const sunX = c.width * (0.2 + rng.next() * 0.6);
  const sunY = horizon * (0.35 + rng.next() * 0.4);
  const sunR = Math.min(c.width, c.height) * 0.07;
  const sun: Rgb = mix(sky1, [255, 255, 240], 0.8);
  const layers = Array.from({ length: 4 }, (_, k) => ({
    base: horizon + (c.height - horizon) * (k / 4) * (lake ? 0.3 : 0.9),
    a: rng.next() * 0.08 + 0.03,
    f1: rng.next() * 4 + 1,
    f2: rng.next() * 9 + 3,
    p: rng.next() * 6,
    color: mix(mix(sky1, land, 0.35), land, k / 3),
  }));
  const ridge = (x: number, k: number) => {
    const l = layers[k] as (typeof layers)[number];
    const u = x / c.width;
    return l.base - c.height * (l.a * Math.sin(u * l.f1 * Math.PI + l.p) + l.a * 0.4 * Math.sin(u * l.f2 * Math.PI + l.p * 2)) - c.height * 0.06 * (3 - k) / 3;
  };
  const waterTop = lake ? horizon + (c.height - horizon) * 0.35 : c.height + 1;
  // Ridge heights depend only on the column, so compute them once per column.
  const ridges = layers.map((_, k) => Float64Array.from({ length: c.width }, (_, x) => ridge(x, k)));
  const skyRows = Array.from({ length: c.height }, (_, y) => mix(sky0, sky1, y / horizon));
  for (let y = 0; y < c.height; y++) {
    const sy = y < waterTop ? y : Math.max(0, Math.round(2 * waterTop - y)); // mirror for the reflection
    for (let x = 0; x < c.width; x++) {
      let color: Rgb = skyRows[Math.min(c.height - 1, sy)] as Rgb;
      let top = -1;
      for (let k = layers.length - 1; k >= 0; k--) {
        if (sy >= (ridges[k] as Float64Array)[x]!) {
          top = k;
          break;
        }
      }
      if (top >= 0) color = (layers[top] as (typeof layers)[number]).color;
      else {
        const d = Math.hypot(x - sunX, sy - sunY);
        if (d < sunR) color = sun;
        else if (d < sunR * 3) color = mix(sun, color, ((d - sunR) / (sunR * 2)) * 0.6 + 0.4);
      }
      if (y >= waterTop) color = mix(color, [40, 70, 110], 0.35 + ((y + (x >> 4)) % 7 === 0 ? 0.1 : 0));
      c.set(x, y, color);
    }
  }
}

export function drawIcon(c: Canvas, rng: Rng, spec: PictureSpec): void {
  const side = Math.min(c.width, c.height);
  if (side < 6) {
    // A few pixels have room for little but color: vary the shade so no two tiny icons are equal.
    c.rect(0, 0, c.width, c.height, mix(spec.accent, WHITE, rng.next() * 0.5));
    if (side >= 2) c.set(Math.floor(c.width / 2), Math.floor(c.height / 2), mix(spec.accent, WHITE, 0.5 + rng.next() * 0.4));
    return;
  }
  c.rect(0, 0, c.width, c.height, WHITE);
  // A seeded shade of the accent keeps every icon file distinct.
  c.roundRect(0, 0, c.width, c.height, side * 0.22, mix(spec.accent, [17, 24, 39], rng.next() * 0.3));
  const glyph = rng.int(0, 3);
  const t = Math.max(1, side * 0.09);
  const m = side * 0.28;
  const light = mix(spec.accent, WHITE, 0.92);
  if (glyph === 0) {
    c.line(m, side * 0.52, side * 0.43, side - m, light, t); // check mark
    c.line(side * 0.43, side - m, side - m, m, light, t);
  } else if (glyph === 1) {
    c.circle(side / 2, side * 0.42, side * 0.2, light); // map pin
    c.triangle([side * 0.32, side * 0.5], [side * 0.68, side * 0.5], [side / 2, side - m * 0.8], light);
    c.circle(side / 2, side * 0.42, side * 0.08, spec.accent);
  } else if (glyph === 2) {
    for (let i = 0; i < 3; i++) c.rect(m + i * side * 0.16, side - m - side * (0.15 + i * 0.13), side * 0.1, side * (0.15 + i * 0.13), light); // bars
  } else {
    const letter = rng.pick(["K", "R", "D", "S", "A"]);
    const scale = Math.max(1, Math.floor(side / 12));
    c.text(side / 2 - (5 * scale) / 2, side / 2 - (7 * scale) / 2, letter, light, scale);
  }
}

export function drawScene(c: Canvas, rng: Rng, spec: PictureSpec): void {
  if (Math.min(c.width, c.height) < 64 && spec.scene !== "photo") return drawIcon(c, rng, spec);
  switch (spec.scene) {
    case "screenshot": return drawScreenshot(c, rng, spec);
    case "phone": return drawPhone(c, rng, spec);
    case "bar-chart": return drawBarChart(c, rng, spec);
    case "line-chart": return drawLineChart(c, rng, spec);
    case "donut-chart": return drawDonutChart(c, rng, spec);
    case "diagram": return drawDiagram(c, rng, spec);
    case "map": return drawMap(c, rng, spec);
    case "photo": return drawPhoto(c, rng);
    case "icon": return drawIcon(c, rng, spec);
  }
}

export function render(width: number, height: number, rng: Rng, spec: PictureSpec): Canvas {
  const background: Rgb = spec.scene === "photo" ? INK : spec.scene === "screenshot" ? [243, 244, 246] : WHITE;
  const c = new Canvas(width, height, background);
  drawScene(c, rng, spec);
  return c;
}

// ---------------------------------------------------------------- SVG

function hex(c: Rgb): string {
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Vector charts and diagrams with real text, for the corpus's SVG files. */
export function svgPicture(width: number, height: number, rng: Rng, spec: PictureSpec, caption: string): string {
  const font = 'font-family="Helvetica, Arial, sans-serif"';
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <title>${esc(caption)}</title>`,
    `  <rect width="${width}" height="${height}" fill="#ffffff"/>`,
  ];
  if (Math.min(width, height) < 64) {
    out.push(`  <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="${Math.round(width * 0.22)}" fill="${hex(mix(spec.accent, INK, rng.next() * 0.3))}"/>`);
    out.push(`  <path d="M${width * 0.28} ${height * 0.52} L${width * 0.43} ${height * 0.7} L${width * 0.72} ${height * 0.3}" stroke="#ffffff" stroke-width="${Math.max(1, width * 0.09).toFixed(1)}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
    out.push("</svg>", "");
    return out.join("\n");
  }
  const fs = Math.max(10, Math.round(height / 28));
  out.push(`  <text x="${fs}" y="${fs * 1.8}" ${font} font-size="${fs * 1.2}" font-weight="bold" fill="${hex(INK)}">${esc(caption)}</text>`);
  const x0 = fs * 3;
  const y0 = fs * 3.2;
  const w = width - x0 - fs;
  const h = height - y0 - fs * 2.4;
  if (spec.scene === "diagram" || spec.scene === "map" || spec.scene === "screenshot" || spec.scene === "phone") {
    const n = spec.labels.length;
    const bw = Math.min(fs * 9, (width - fs * 2) / n - fs * 1.5);
    const bh = fs * 2.6;
    const cy = y0 + h / 2;
    out.push(`  <defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="${hex(MUTED)}"/></marker></defs>`);
    spec.labels.forEach((label, i) => {
      const cx = fs + ((width - fs * 2) / n) * (i + 0.5);
      const color = ACCENTS[(i + ACCENTS.indexOf(spec.accent) + ACCENTS.length) % ACCENTS.length] as Rgb;
      const y = cy + (i % 2 === 0 ? -1 : 1) * rng.int(0, Math.round(fs * 1.5));
      out.push(`  <rect x="${(cx - bw / 2).toFixed(1)}" y="${(y - bh / 2).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh}" rx="${fs * 0.5}" fill="${hex(mix(color, WHITE, 0.85))}" stroke="${hex(color)}" stroke-width="1.5"/>`);
      out.push(`  <text x="${cx.toFixed(1)}" y="${(y + fs * 0.35).toFixed(1)}" ${font} font-size="${fs}" text-anchor="middle" fill="${hex(INK)}">${esc(label)}</text>`);
      if (i > 0) {
        const px = fs + ((width - fs * 2) / n) * (i - 0.5) + bw / 2;
        out.push(`  <line x1="${px.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${(cx - bw / 2 - 3).toFixed(1)}" y2="${cy.toFixed(1)}" stroke="${hex(MUTED)}" stroke-width="1.5" marker-end="url(#head)"/>`);
      }
    });
  } else if (spec.scene === "donut-chart") {
    const r = Math.min(w, h) * 0.42;
    const cx = x0 + r;
    const cy = y0 + h / 2;
    const values = spec.labels.map(() => rng.int(10, 40));
    const total = values.reduce((a, b) => a + b, 0);
    let angle = -Math.PI / 2;
    values.forEach((v, i) => {
      const next = angle + (v / total) * 2 * Math.PI;
      const large = next - angle > Math.PI ? 1 : 0;
      const p = (a: number, rr: number) => `${(cx + rr * Math.cos(a)).toFixed(1)} ${(cy + rr * Math.sin(a)).toFixed(1)}`;
      const color = hex(ACCENTS[(i + ACCENTS.indexOf(spec.accent) + ACCENTS.length) % ACCENTS.length] as Rgb);
      out.push(`  <path d="M${p(angle, r)} A${r.toFixed(1)} ${r.toFixed(1)} 0 ${large} 1 ${p(next, r)} L${p(next, r * 0.6)} A${(r * 0.6).toFixed(1)} ${(r * 0.6).toFixed(1)} 0 ${large} 0 ${p(angle, r * 0.6)} Z" fill="${color}"/>`);
      out.push(`  <rect x="${(cx + r + fs * 2).toFixed(1)}" y="${(y0 + i * fs * 1.6).toFixed(1)}" width="${fs * 0.8}" height="${fs * 0.8}" rx="2" fill="${color}"/>`);
      out.push(`  <text x="${(cx + r + fs * 3.2).toFixed(1)}" y="${(y0 + i * fs * 1.6 + fs * 0.75).toFixed(1)}" ${font} font-size="${fs}" fill="${hex(INK)}">${esc(spec.labels[i] as string)} (${Math.round((v * 100) / total)}%)</text>`);
      angle = next;
    });
  } else {
    for (let i = 0; i <= 4; i++) {
      const gy = y0 + (h * i) / 4;
      out.push(`  <line x1="${x0}" y1="${gy.toFixed(1)}" x2="${x0 + w}" y2="${gy.toFixed(1)}" stroke="${hex(LINE)}"/>`);
      out.push(`  <text x="${x0 - fs * 0.5}" y="${(gy + fs * 0.35).toFixed(1)}" ${font} font-size="${fs * 0.85}" text-anchor="end" fill="${hex(MUTED)}">${(4 - i) * 25}</text>`);
    }
    const n = spec.labels.length;
    const values = spec.labels.map(() => rng.int(20, 95) / 100);
    if (spec.scene === "line-chart" || spec.scene === "photo") {
      const pts = values.map((v, i) => `${(x0 + (w * i) / Math.max(1, n - 1)).toFixed(1)},${(y0 + h - h * v).toFixed(1)}`);
      out.push(`  <polyline points="${pts.join(" ")}" fill="none" stroke="${hex(spec.accent)}" stroke-width="${Math.max(2, fs / 5).toFixed(1)}" stroke-linejoin="round"/>`);
      for (const pt of pts) out.push(`  <circle cx="${pt.split(",")[0]}" cy="${pt.split(",")[1]}" r="${(fs / 4).toFixed(1)}" fill="${hex(spec.accent)}"/>`);
    } else {
      const slot = w / n;
      values.forEach((v, i) => {
        out.push(`  <rect x="${(x0 + i * slot + slot * 0.18).toFixed(1)}" y="${(y0 + h - h * v).toFixed(1)}" width="${(slot * 0.64).toFixed(1)}" height="${(h * v).toFixed(1)}" rx="3" fill="${hex(spec.accent)}"/>`);
      });
    }
    spec.labels.forEach((label, i) => {
      const x = spec.scene === "line-chart" ? x0 + (w * i) / Math.max(1, n - 1) : x0 + (w / n) * (i + 0.5);
      out.push(`  <text x="${x.toFixed(1)}" y="${(y0 + h + fs * 1.4).toFixed(1)}" ${font} font-size="${fs * 0.85}" text-anchor="middle" fill="${hex(MUTED)}">${esc(label)}</text>`);
    });
  }
  out.push("</svg>", "");
  return out.join("\n");
}

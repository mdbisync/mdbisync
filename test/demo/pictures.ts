// Charts and box diagrams of the demo corpus, drawn as PNG from the data
// files under data/. The same data also gives the document's table and CSV
// attachment, so a chart never disagrees with its text.

import { hex, Raster, type Point, type Rgb } from "./raster.ts";

/** A chart: vertical bars, horizontal bars or lines over the same categories. */
export type ChartData = {
  type: "bar" | "hbar" | "line";
  title: string;
  subtitle: string;
  /** The first table column's header, for example "Payload size". */
  category: string;
  categories: string[];
  /** The value unit, shown on the axis and in table headers, for example "ms". */
  unit: string;
  /** 1 to 4 series. */
  series: { name: string; values: number[] }[];
  /** Alt text for the image. */
  alt: string;
  /** Fixed y-axis range; computed from the data when absent. */
  min?: number;
  max?: number;
};

/** A box diagram: boxes placed on a grid, joined by arrows. */
export type DiagramData = {
  type: "diagram";
  title: string;
  subtitle: string;
  alt: string;
  /** Row names, drawn at the left; each row has its own tint. */
  rows: string[];
  nodes: { id: string; label: string; detail?: string; row: number; col: number }[];
  edges: { from: string; to: string; label?: string; dashed?: boolean }[];
};

export type PictureData = ChartData | DiagramData;

const SURFACE = hex("#fcfcfb");
const INK = hex("#0b0b0b");
const SECONDARY = hex("#52514e");
const MUTED = hex("#8a8984");
const GRID = hex("#e7e6e2");
const AXIS = hex("#c9c8c2");
export const SERIES: readonly Rgb[] = [hex("#2a78d6"), hex("#eb6834"), hex("#1baf7a"), hex("#eda100")];
const ROW_TINTS: readonly Rgb[] = [hex("#eaf2fc"), hex("#fdeee7"), hex("#e6f6ef"), hex("#fdf4de"), hex("#f1effb")];
const ROW_EDGES: readonly Rgb[] = [hex("#2a78d6"), hex("#eb6834"), hex("#1baf7a"), hex("#eda100"), hex("#6250d6")];

const WIDTH = 1600;

/** Formats a number for axes and tables: thousands separators, at most two decimals. */
export function formatNumber(v: number): string {
  const rounded = Math.round(v * 100) / 100;
  const [int, frac] = Math.abs(rounded).toString().split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${rounded < 0 ? "−" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

function niceStep(range: number, ticks: number): number {
  const raw = range / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
}

function scale(data: ChartData): { lo: number; hi: number; step: number } {
  const values = data.series.flatMap((s) => s.values);
  const lo0 = data.min ?? Math.min(0, ...values);
  const hi0 = data.max ?? Math.max(...values);
  const step = niceStep(hi0 - lo0 || 1, 5);
  return { lo: Math.floor(lo0 / step) * step, hi: Math.ceil(hi0 / step) * step, step };
}

function header(r: Raster, title: string, subtitle: string): number {
  r.text(64, 76, title, INK, "title");
  r.text(64, 120, subtitle, SECONDARY, "regular");
  return 120;
}

function legend(r: Raster, data: ChartData, y: number): void {
  if (data.series.length < 2) return;
  let x = 64;
  data.series.forEach((s, i) => {
    r.roundRect(x, y - 18, 20, 20, 4, SERIES[i]!);
    x += 30 + r.text(x + 30, y, s.name, SECONDARY, "regular") + 36;
  });
}

function unitLabel(v: number, unit: string): string {
  if (!unit) return formatNumber(v);
  return unit === "%" ? `${formatNumber(v)} %` : `${formatNumber(v)} ${unit}`;
}

function drawVertical(data: ChartData): Raster {
  const height = 900;
  const r = new Raster(WIDTH, height, SURFACE);
  header(r, data.title, data.subtitle);
  legend(r, data, 176);
  const { lo, hi, step } = scale(data);
  const top = data.series.length > 1 ? 220 : 180;
  const bottom = height - 110;
  const labels = [] as string[];
  for (let v = lo; v <= hi + step / 2; v += step) labels.push(unitLabel(v, data.unit));
  const left = 64 + Math.max(...labels.map((l) => r.measure(l, "regular"))) + 20;
  const endLabel = (s: { name: string; values: number[] }) => `${s.name.length > 24 ? s.name.slice(0, 23) + "…" : s.name} ${formatNumber(s.values[s.values.length - 1]!)}`;
  const right = WIDTH - 64 - (data.type === "line" ? 28 + Math.max(...data.series.map((s) => r.measure(endLabel(s), "bold"))) : 0);
  const y = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  for (let v = lo, i = 0; v <= hi + step / 2; v += step, i++) {
    r.line([left, y(v)], [right, y(v)], v === 0 ? AXIS : GRID, 2);
    r.text(left - 16, y(v) + 9, labels[i]!, MUTED, "regular", "right");
  }
  const n = data.categories.length;
  const band = (right - left) / n;
  const every = Math.ceil(n / Math.floor((right - left) / (Math.max(...data.categories.map((c) => r.measure(c, "regular"))) + 24)));
  data.categories.forEach((c, i) => {
    if (i % every === 0) r.text(left + band * (i + 0.5), bottom + 44, c, SECONDARY, "regular", "center");
  });
  if (data.type === "bar") {
    const k = data.series.length;
    const inner = band * 0.72;
    const gap = 4;
    const bw = (inner - gap * (k - 1)) / k;
    data.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        const x = left + band * i + (band - inner) / 2 + si * (bw + gap);
        const y0 = y(Math.max(0, lo));
        const y1 = y(v);
        r.roundRect(x, Math.min(y0, y1), bw, Math.abs(y0 - y1), 8, SERIES[si]!, v >= 0 ? [true, true, false, false] : [false, false, true, true]);
        if (n * k <= 12) r.text(x + bw / 2, y1 - 14, formatNumber(v), SECONDARY, "regular", "center");
      });
    });
  } else {
    data.series.forEach((s, si) => {
      const pts: Point[] = s.values.map((v, i) => [left + band * (i + 0.5), y(v)]);
      r.polyline(pts, SERIES[si]!, 4);
      if (n <= 16) for (const p of pts) {
        r.circle(p[0], p[1], 8, SURFACE);
        r.circle(p[0], p[1], 6, SERIES[si]!);
      }
    });
    // Direct end labels, nudged apart so they never overlap.
    const ends = data.series.map((s, si) => ({ si, y: y(s.values[s.values.length - 1]!) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i]!.y - ends[i - 1]!.y < 34) ends[i]!.y = ends[i - 1]!.y + 34;
    for (const e of ends) {
      const s = data.series[e.si]!;
      r.text(right + 28, e.y + 9, endLabel(s), SECONDARY, "bold");
    }
  }
  return r;
}

function drawHorizontal(data: ChartData): Raster {
  const n = data.categories.length;
  const k = data.series.length;
  const rowH = Math.max(56, 26 * k + 26);
  const top = k > 1 ? 210 : 170;
  const height = top + n * rowH + 60;
  const r = new Raster(WIDTH, height, SURFACE);
  header(r, data.title, data.subtitle);
  legend(r, data, 176);
  const left = 64 + Math.max(...data.categories.map((c) => r.measure(c, "regular"))) + 24;
  const right = WIDTH - 200;
  const { lo, hi } = scale(data);
  const x = (v: number) => left + ((v - lo) / (hi - lo)) * (right - left);
  r.line([x(Math.max(0, lo)), top - 10], [x(Math.max(0, lo)), top + n * rowH], AXIS, 2);
  data.categories.forEach((c, i) => {
    const y0 = top + i * rowH;
    r.text(left - 20, y0 + rowH / 2 + 9, c, INK, "regular", "right");
    const bh = (rowH - 22 - 4 * (k - 1)) / k;
    data.series.forEach((s, si) => {
      const v = s.values[i]!;
      const by = y0 + 11 + si * (bh + 4);
      const x0 = x(Math.max(0, lo));
      r.roundRect(x0, by, Math.max(2, x(v) - x0), bh, 6, SERIES[si]!, [false, true, true, false]);
      r.text(x(v) + 12, by + bh / 2 + 9, unitLabel(v, data.unit), SECONDARY, "regular");
    });
  });
  return r;
}

function wrap(r: Raster, text: string, width: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && r.measure(next, "regular") > width) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function drawDiagram(data: DiagramData): Raster {
  const cols = Math.max(...data.nodes.map((n) => n.col)) + 1;
  const rows = data.rows.length;
  const rowH = 200;
  const top = 170;
  const height = top + rows * rowH + 40;
  const r = new Raster(WIDTH, height, SURFACE);
  header(r, data.title, data.subtitle);
  // The row names take the room they need, at least the 236 px of most diagrams.
  const left = Math.max(300, 96 + Math.max(...data.rows.map((name) => r.measure(name, "bold"))) + 40);
  const right = WIDTH - 64;
  const colW = (right - left) / cols;
  const boxW = Math.min(300, colW - 48);
  const boxH = 136;
  data.rows.forEach((name, i) => {
    const y0 = top + i * rowH;
    r.roundRect(64, y0 + 8, WIDTH - 128, rowH - 16, 16, ROW_TINTS[i % ROW_TINTS.length]!);
    r.text(96, y0 + rowH / 2 + 9, name, SECONDARY, "bold");
  });
  const centre = new Map<string, Point>();
  for (const n of data.nodes) centre.set(n.id, [left + colW * (n.col + 0.5), top + rowH * n.row + rowH / 2]);
  const boxEdge = (from: Point, to: Point): Point => {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const tx = dx === 0 ? Infinity : boxW / 2 / Math.abs(dx);
    const ty = dy === 0 ? Infinity : boxH / 2 / Math.abs(dy);
    const t = Math.min(tx, ty);
    return [from[0] + dx * t, from[1] + dy * t];
  };
  for (const e of data.edges) {
    const a = centre.get(e.from);
    const b = centre.get(e.to);
    if (!a || !b) throw new Error(`diagram "${data.title}": unknown node in edge ${e.from} -> ${e.to}`);
    const pa = boxEdge(a, b);
    const pb0 = boxEdge(b, a);
    const len = Math.hypot(pb0[0] - pa[0], pb0[1] - pa[1]);
    const pb: Point = [pb0[0] - ((pb0[0] - pa[0]) / len) * 6, pb0[1] - ((pb0[1] - pa[1]) / len) * 6];
    if (e.dashed) {
      r.dashed(pa, [pb[0] - ((pb[0] - pa[0]) / len) * 16, pb[1] - ((pb[1] - pa[1]) / len) * 16], SECONDARY, 3, 10);
      r.arrow([pb[0] - ((pb[0] - pa[0]) / len) * 18, pb[1] - ((pb[1] - pa[1]) / len) * 18], pb, SECONDARY, 3, 18);
    } else r.arrow(pa, pb, SECONDARY, 3, 18);
    if (e.label) {
      const mx = (pa[0] + pb[0]) / 2;
      const flat = Math.abs(pb[1] - pa[1]) < Math.abs(pb[0] - pa[0]) / 3;
      const my = (pa[1] + pb[1]) / 2 - (flat ? 22 : 0);
      const w = r.measure(e.label, "regular") + 20;
      r.roundRect(mx - w / 2, my - 22, w, 34, 8, SURFACE);
      r.text(mx, my + 3, e.label, SECONDARY, "regular", "center");
    }
  }
  for (const n of data.nodes) {
    const [cx, cy] = centre.get(n.id)!;
    const edge = ROW_EDGES[n.row % ROW_EDGES.length]!;
    r.roundRect(cx - boxW / 2 - 2, cy - boxH / 2 - 2, boxW + 4, boxH + 4, 14, edge);
    r.roundRect(cx - boxW / 2 + 2, cy - boxH / 2 + 2, boxW - 4, boxH - 4, 11, hex("#ffffff"));
    const detail = n.detail ? wrap(r, n.detail, boxW - 32).slice(0, 2) : [];
    const block = 30 + detail.length * 30;
    let y = cy - block / 2 + 22;
    // A label too wide for its box in bold is drawn in the regular face, which is narrower.
    r.text(cx, y, n.label, INK, r.measure(n.label, "bold") > boxW - 24 ? "regular" : "bold", "center");
    for (const d of detail) {
      y += 32;
      r.text(cx, y, d, SECONDARY, "regular", "center");
    }
  }
  return r;
}

export function drawPicture(data: PictureData): Buffer {
  if (data.type === "diagram") return drawDiagram(data).png();
  if (data.type === "hbar") return drawHorizontal(data).png();
  return drawVertical(data).png();
}

/** The Markdown table of a chart's data: one row per category, one column per series. */
export function chartTable(data: ChartData): string {
  const unit = data.unit ? ` (${data.unit})` : "";
  const head = `| ${data.category} | ${data.series.map((s) => `${s.name}${unit}`).join(" | ")} |`;
  const sep = `| ${["--", ...data.series.map(() => "--")].join(" | ")} |`;
  const rows = data.categories.map((c, i) => `| ${c} | ${data.series.map((s) => formatNumber(s.values[i]!)).join(" | ")} |`);
  return [head, sep, ...rows].join("\n");
}

/** The CSV of a chart's data, with a machine-friendly header. */
export function chartCsv(data: ChartData): string {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const unit = data.unit ? `_${key(data.unit === "%" ? "pct" : data.unit)}` : "";
  const rows = [[key(data.category), ...data.series.map((s) => `${key(s.name)}${unit}`)].join(",")];
  data.categories.forEach((c, i) => rows.push([c.includes(",") ? `"${c}"` : c, ...data.series.map((s) => String(s.values[i]))].join(",")));
  return `${rows.join("\n")}\n`;
}

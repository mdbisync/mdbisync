// SVG documents for the corpus: plain shapes, text in several scripts and
// an embedded title, all generated from the seed.

import type { Rng } from "../rng.ts";

export type SvgOptions = {
  width: number;
  height: number;
  shapes: number;
  /** Optional text label drawn in the image and given as its title. */
  label?: string;
};

function color(rng: Rng): string {
  return `#${rng.hex(6)}`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function makeSvg(rng: Rng, options: SvgOptions): string {
  const { width, height, shapes, label } = options;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  ];
  if (label !== undefined) parts.push(`  <title>${escapeXml(label)}</title>`);
  parts.push(`  <rect width="${width}" height="${height}" fill="${color(rng)}"/>`);
  for (let i = 0; i < shapes; i++) {
    const kind = rng.int(0, 2);
    if (kind === 0) {
      const r = rng.int(1, Math.max(1, Math.floor(Math.min(width, height) / 4)));
      parts.push(`  <circle cx="${rng.int(0, width)}" cy="${rng.int(0, height)}" r="${r}" fill="${color(rng)}"/>`);
    } else if (kind === 1) {
      parts.push(
        `  <rect x="${rng.int(0, width)}" y="${rng.int(0, height)}" width="${rng.int(1, width)}" height="${rng.int(1, height)}" fill="${color(rng)}" opacity="0.7"/>`,
      );
    } else {
      const points = Array.from({ length: 3 }, () => `${rng.int(0, width)},${rng.int(0, height)}`).join(" ");
      parts.push(`  <polygon points="${points}" fill="${color(rng)}"/>`);
    }
  }
  if (label !== undefined) {
    parts.push(
      `  <text x="${Math.floor(width / 2)}" y="${Math.floor(height / 2)}" font-size="${Math.max(6, Math.floor(height / 8))}" text-anchor="middle">${escapeXml(label)}</text>`,
    );
  }
  parts.push("</svg>", "");
  return parts.join("\n");
}

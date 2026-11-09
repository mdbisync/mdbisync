// Builds the demo corpus: the documents of DemoCompany, a made-up company,
// for screenshots and videos of a repository's documents in Linear.
//
//   node test/demo/generate.ts --out <dir> [--replace] [--partial]
//
// --partial turns links to documents that do not exist yet into plain text,
// for building while the content is still being written.
//
// The documents are written by hand under content/, in the folder layout of
// the demo repository. The generator adds what is drawn from data and puts
// every Markdown file into Linear's form with `fix`:
//
//   [text](@ADR-014)        a link to the document whose title starts with that id
//   @@picture:<id>@@        an image drawn from data/<id>.json (a chart or a diagram)
//   @@table:<id>@@          the chart's data as a table
//   @@csv:<id>@@            the chart's data as an attached CSV file
//
// Pictures go to an images/ folder and CSV files to a files/ folder beside
// the document. The same content always gives the same bytes.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fixText, lintText } from "../../src/format/index.ts";
import { chartCsv, chartTable, drawPicture, type ChartData, type PictureData } from "./pictures.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const CONTENT = join(here, "content");
export const DATA = join(here, "data");

export type DemoFile = { path: string; bytes: Buffer };

function walk(root: string, dir = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir)).sort()) {
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

/** The id a document title starts with, such as ADR-014 or RFC-007. */
export function idOf(path: string): string | null {
  return /^([A-Z]+-\d+) /.exec(posix.basename(path))?.[1] ?? null;
}

function readData(id: string): PictureData {
  const file = join(DATA, `${id}.json`);
  if (!existsSync(file)) throw new Error(`no data file for "${id}" (data/${id}.json)`);
  return JSON.parse(readFileSync(file, "utf8")) as PictureData;
}

function asChart(id: string, data: PictureData, path: string): ChartData {
  if (data.type === "diagram") throw new Error(`${path}: "${id}" is a diagram, not a chart`);
  return data;
}

/** Builds every file of the corpus, keyed by its path relative to the corpus root. */
export function buildDemo(content = CONTENT, options: { partial?: boolean } = {}): DemoFile[] {
  const sources = walk(content);
  const ids = new Map<string, string>();
  for (const path of sources) {
    const id = idOf(path);
    if (!id || !path.endsWith(".md")) continue;
    if (ids.has(id)) throw new Error(`id ${id} is used twice: ${ids.get(id)} and ${path}`);
    ids.set(id, path);
  }
  const files = new Map<string, Buffer>();
  const add = (path: string, bytes: Buffer) => {
    const previous = files.get(path);
    if (previous && !previous.equals(bytes)) throw new Error(`two different files at ${path}`);
    files.set(path, bytes);
  };
  for (const path of sources) {
    const raw = readFileSync(join(content, path));
    if (!path.endsWith(".md")) {
      add(path, raw);
      continue;
    }
    const folder = posix.dirname(path);
    let text = raw.toString("utf8");
    text = text.replace(/\[([^\]]*)\]\(@([A-Z]+-\d+)\)/g, (_m, label: string, id: string) => {
      const target = ids.get(id);
      if (!target && options.partial) return label;
      if (!target) throw new Error(`${path}: link to unknown document ${id}`);
      return `[${label}](<${posix.relative(folder, target)}>)`;
    });
    if (text.includes("](@")) throw new Error(`${path}: an id link the generator could not read`);
    text = text.replace(/^@@(picture|table|csv):([a-z0-9-]+)@@$/gm, (_m, kind: string, id: string) => {
      const data = readData(id);
      if (kind === "picture") {
        add(posix.join(folder, "images", `${id}.png`), drawPicture(data));
        return `![${data.alt}](images/${id}.png)`;
      }
      const chart = asChart(id, data, path);
      if (kind === "table") return chartTable(chart);
      add(posix.join(folder, "files", `${id}.csv`), Buffer.from(chartCsv(chart)));
      return `* [${id}.csv](<files/${id}.csv>)`;
    });
    if (/@@[a-z]+:/.test(text)) throw new Error(`${path}: unknown directive`);
    const findings = lintText(path, text);
    if (findings.length > 0) throw new Error(`${path}: ${findings.map((f) => `line ${f.line}: ${f.rule}`).join(", ")}`);
    add(path, Buffer.from(fixText(text)));
  }
  return [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, bytes]) => ({ path, bytes }));
}

function main(): void {
  const { values } = parseArgs({ options: { out: { type: "string" }, replace: { type: "boolean", default: false }, partial: { type: "boolean", default: false } } });
  if (!values.out) throw new Error("usage: node test/demo/generate.ts --out <dir> [--replace]");
  const out = resolve(values.out);
  if (existsSync(out) && readdirSync(out).length > 0) {
    if (!values.replace) throw new Error(`${out} is not empty; pass --replace to rebuild it`);
    for (const name of readdirSync(out)) if (name !== ".git") rmSync(join(out, name), { recursive: true });
  }
  const files = buildDemo(CONTENT, { partial: values.partial });
  for (const file of files) {
    mkdirSync(dirname(join(out, file.path)), { recursive: true });
    writeFileSync(join(out, file.path), file.bytes);
  }
  const docs = files.filter((f) => f.path.endsWith(".md")).length;
  console.log(`wrote ${files.length} files (${docs} documents) to ${relative(process.cwd(), out) || "."}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

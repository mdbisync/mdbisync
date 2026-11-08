// Checks a corpus on disk against its manifest and the composition rules.
//
//   node test/corpus/check.ts <root> [--git]
//
// <root> holds `corpus/` and `corpus-slices/`, as the generator writes them
// and as they lie in the test repository. With --git the root is a checkout
// made without LFS smudging, so every LFS file must be a pointer and no
// other file may be one.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Manifest, ManifestEntry } from "./generate.ts";
import { GROUPS, isLfs, MAX_LFS_BYTES, MAX_NON_LFS_IMAGES, MIN_TOTAL_FILES, MINIMUMS, CANARY, type Group } from "./model.ts";
import { SLICES } from "./slices.ts";

export type CheckResult = {
  problems: string[];
  files: number;
  documents: number;
  lfsBytes: number;
  nonLfsImages: number;
  groups: Record<string, number>;
};

const CYRILLIC = /[\u0400-\u052f\u1c80-\u1c8f\u2de0-\u2dff\ua640-\ua69f]/u;
const POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:[0-9a-f]{64}\nsize (\d+)\n$/;

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(full.slice(base.length + 1).split("\\").join("/"));
  }
  return out;
}

function utf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function checkCorpus(root: string, options: { git?: boolean } = {}): CheckResult {
  const problems: string[] = [];
  const treeDir = join(root, "corpus");
  const manifest = JSON.parse(readFileSync(join(root, "corpus-slices", "manifest.json"), "utf8")) as Manifest;
  const entries = new Map<string, ManifestEntry>(manifest.files.map((f) => [f.path, f]));

  // The tree and the manifest list the same files.
  const onDisk = new Set(walk(treeDir));
  for (const path of onDisk) if (!entries.has(path)) problems.push(`not in the manifest: ${path}`);
  for (const path of entries.keys()) if (!onDisk.has(path)) problems.push(`missing from the tree: ${path}`);

  // Counts per group.
  const groups: Record<string, number> = {};
  for (const entry of entries.values()) groups[entry.group] = (groups[entry.group] ?? 0) + 1;
  for (const group of GROUPS) {
    const minimum = MINIMUMS[group as Group];
    if (minimum !== undefined && (groups[group] ?? 0) < minimum) problems.push(`group ${group} has ${groups[group] ?? 0} files, fewer than ${minimum}`);
  }
  if (entries.size < MIN_TOTAL_FILES) problems.push(`the corpus has ${entries.size} files, fewer than ${MIN_TOTAL_FILES}`);

  let lfsBytes = 0;
  let nonLfsImages = 0;
  const canaries = new Map<string, string>();
  for (const entry of entries.values()) {
    if (!onDisk.has(entry.path)) continue;
    const full = join(treeDir, entry.path);
    const bytes = readFileSync(full);
    const pointer = POINTER.exec(bytes.toString("latin1"));

    // LFS routing follows the .gitattributes rules.
    if (entry.lfs !== isLfs(entry.path)) problems.push(`LFS flag does not match the attributes: ${entry.path}`);
    if (options.git === true) {
      if (entry.lfs && !pointer) problems.push(`expected an LFS pointer: ${entry.path}`);
      if (!entry.lfs && pointer) problems.push(`unexpected LFS pointer: ${entry.path}`);
    }
    const size = pointer ? Number(pointer[1]) : statSync(full).size;
    if (size !== entry.bytes) problems.push(`size ${size} differs from the manifest's ${entry.bytes}: ${entry.path}`);
    if (entry.lfs) lfsBytes += size;
    else if (entry.kind === "image") nonLfsImages++;

    // No Cyrillic in any text file; binary content is skipped.
    const text = pointer ? null : utf8(bytes);
    if (text !== null) {
      const lines = text.split("\n");
      const line = lines.findIndex((l) => CYRILLIC.test(l));
      if (line >= 0) problems.push(`Cyrillic character: ${entry.path}:${line + 1}`);
    }
    if (CYRILLIC.test(entry.path)) problems.push(`Cyrillic character in a path: ${entry.path}`);

    // A canary in every Markdown file: in its bytes (a canary is ASCII, so this
    // covers binary files too), or in its name when the file holds no text.
    if (entry.path.endsWith(".md")) {
      if (entry.canary === null || !CANARY.test(entry.canary)) problems.push(`no canary: ${entry.path}`);
      else if (entry.canary_in === "name" ? !basename(entry.path).includes(entry.canary) : !bytes.includes(Buffer.from(entry.canary, "ascii"))) {
        problems.push(`canary ${entry.canary} not found ${entry.canary_in === "name" ? "in the name" : "in the content"}: ${entry.path}`);
      }
    }
    if (entry.canary !== null) {
      const other = canaries.get(entry.canary);
      if (other !== undefined) problems.push(`canary ${entry.canary} is shared by ${other} and ${entry.path}`);
      canaries.set(entry.canary, entry.path);
    }
  }
  if (lfsBytes >= MAX_LFS_BYTES) problems.push(`LFS holds ${lfsBytes} bytes, not under ${MAX_LFS_BYTES}`);
  if (nonLfsImages > MAX_NON_LFS_IMAGES) problems.push(`${nonLfsImages} images are outside LFS, more than ${MAX_NON_LFS_IMAGES}`);

  // Slices name only corpus files, sorted and without duplicates.
  for (const slice of SLICES) {
    const { paths } = JSON.parse(readFileSync(join(root, "corpus-slices", `${slice}.json`), "utf8")) as { paths: string[] };
    const sorted = [...new Set(paths)].sort();
    if (sorted.length !== paths.length || sorted.some((p, i) => p !== paths[i])) problems.push(`slice ${slice} is not sorted or has duplicates`);
    for (const path of paths) if (!entries.has(path)) problems.push(`slice ${slice} names a path the corpus does not have: ${path}`);
  }

  const documents = [...entries.values()].filter((e) => e.synced && e.kind === "markdown").length;
  return { problems, files: entries.size, documents, lfsBytes, nonLfsImages, groups };
}

function main(): void {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { git: { type: "boolean", default: false } } });
  const root = resolve(positionals[0] ?? ".");
  const result = checkCorpus(root, { git: values.git });
  for (const problem of result.problems) console.error(problem);
  const groups = Object.entries(result.groups).map(([g, n]) => `${g} ${n}`).join(", ");
  console.log(
    `${result.problems.length === 0 ? "corpus ok" : `corpus FAILED (${result.problems.length} problems)`}: ${result.files} files, ${result.documents} documents, ` +
      `${(result.lfsBytes / 1024 / 1024).toFixed(1)} MiB in LFS, ${result.nonLfsImages} images outside LFS; ${groups}`,
  );
  process.exitCode = result.problems.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

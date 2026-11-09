// Checks a corpus on disk against its manifest and the composition rules.
//
//   node test/corpus/check.ts <root> [--git] [--lint]
//
// <root> holds `corpus/` and `corpus-slices/`, as the generator writes them
// and as they lie in the test repository. With --git the root is a checkout
// made without LFS smudging, so every LFS file must be a pointer and no
// other file may be one. With --lint, the exact set of synced Markdown
// paths with lint findings must equal the manifest's lint-error paths, and
// every other synced Markdown file must already be in Linear's form: `fix`
// leaves it byte for byte as it is.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { duplicateTitles, fixText, linkedFileCheck, lintText, type Finding } from "../../src/format/index.ts";
import { findCyrillicLines } from "../../tools/check-no-cyrillic.ts";
import type { Manifest, ManifestEntry } from "./generate.ts";
import { gitattributes, GROUPS, isLfs, MAX_LFS_BYTES, MAX_NON_LFS_IMAGES, MIN_TOTAL_FILES, MINIMUMS, CANARY, ROLES, SHARED_IMAGE_SLICES, SHARED_IMAGE_USERS, type Group } from "./model.ts";
import { midRegressions, SLICES } from "./slices.ts";

export type CheckResult = {
  problems: string[];
  files: number;
  documents: number;
  lfsBytes: number;
  nonLfsImages: number;
  groups: Record<string, number>;
};

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

/** Compare lint-error membership only; fixable formatting is not a content-loss error. */
export function checkLintExpectations(
  root: string,
  manifest: Manifest = JSON.parse(readFileSync(join(root, "corpus-slices", "manifest.json"), "utf8")) as Manifest,
): string[] {
  const documents = manifest.files.filter((f) => f.synced && f.kind === "markdown");
  const expected = new Set(documents.filter((f) => f.class === "lint-error").map((f) => f.path));
  const actual = new Map<string, Set<string>>();
  const present: string[] = [];
  const problems: string[] = [];
  const record = (finding: Finding): void => {
    const rules = actual.get(finding.file) ?? new Set<string>();
    rules.add(finding.rule);
    actual.set(finding.file, rules);
  };
  for (const file of documents) {
    const path = join(root, "corpus", file.path);
    if (!existsSync(path)) {
      problems.push(`missing from the tree: ${file.path}`);
      expected.delete(file.path);
      continue;
    }
    present.push(file.path);
    for (const finding of lintText(file.path, readFileSync(path, "utf8"))) record(finding);
  }
  for (const finding of duplicateTitles(present)) record(finding);
  for (const path of [...expected].sort()) {
    if (!actual.has(path)) problems.push(`missing lint-error: ${path}`);
  }
  for (const path of [...actual.keys()].sort()) {
    const rules = actual.get(path)!;
    if (!expected.has(path)) problems.push(`unexpected lint-error: ${path} (${[...rules].sort().join(", ")})`);
  }
  return problems;
}

/** Synced Markdown files outside the lint-error set that `fix` would still change. */
export function checkLinearForm(
  root: string,
  manifest: Manifest = JSON.parse(readFileSync(join(root, "corpus-slices", "manifest.json"), "utf8")) as Manifest,
): string[] {
  const problems: string[] = [];
  const paths = new Set(manifest.files.map((file) => file.path));
  for (const file of manifest.files) {
    if (!file.synced || file.kind !== "markdown" || file.class === "lint-error") continue;
    const path = join(root, "corpus", file.path);
    if (!existsSync(path)) continue; // reported by the tree check
    const text = readFileSync(path, "utf8");
    // A link to a file the corpus does not have is not uploaded, as in the generator.
    if (fixText(text, { linkedFileExists: linkedFileCheck(file.path, (target) => paths.has(target)) }) !== text) problems.push(`not in Linear's form: ${file.path}`);
  }
  return problems;
}

export function checkCorpus(root: string, options: { git?: boolean; lint?: boolean } = {}): CheckResult {
  const problems: string[] = [];
  const treeDir = join(root, "corpus");
  const manifest = JSON.parse(readFileSync(join(root, "corpus-slices", "manifest.json"), "utf8")) as Manifest;
  const entries = new Map<string, ManifestEntry>(manifest.files.map((f) => [f.path, f]));

  // The tree and the manifest list the same files.
  const onDisk = new Set(walk(treeDir));
  for (const path of onDisk) if (!entries.has(path)) problems.push(`not in the manifest: ${path}`);
  for (const path of entries.keys()) if (!onDisk.has(path)) problems.push(`missing from the tree: ${path}`);

  // The attributes on disk are exactly the rules the LFS flags below are checked
  // against, so a changed .gitattributes cannot pass with routing that differs.
  const attributesPath = join(treeDir, ".gitattributes");
  const attributes = onDisk.has(".gitattributes") ? readFileSync(attributesPath, "utf8") : null;
  if (attributes !== gitattributes()) problems.push(".gitattributes differs from the corpus LFS rules");

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

    // LFS routing follows the .gitattributes rules, checked above to be the ones on disk.
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
    // The same character set as the repository's own Cyrillic guard.
    const line = text === null ? undefined : findCyrillicLines(text)[0];
    if (line !== undefined) problems.push(`Cyrillic character: ${entry.path}:${line}`);
    if (findCyrillicLines(entry.path).length > 0) problems.push(`Cyrillic character in a path: ${entry.path}`);

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

  // Every role is on exactly one file, and no file has a role outside the list.
  for (const role of ROLES) {
    const holders = [...entries.values()].filter((e) => e.role === role).map((e) => e.path);
    if (holders.length !== 1) problems.push(`role ${role} is on ${holders.length} files${holders.length > 0 ? `: ${holders.join(", ")}` : ""}`);
  }
  for (const entry of entries.values()) {
    if (entry.role !== undefined && entry.role !== null && !(ROLES as readonly string[]).includes(entry.role)) problems.push(`unknown role ${entry.role}: ${entry.path}`);
  }

  // Slices name only corpus files, sorted and without duplicates.
  for (const slice of SLICES) {
    const { paths } = JSON.parse(readFileSync(join(root, "corpus-slices", `${slice}.json`), "utf8")) as { paths: string[] };
    const sorted = [...new Set(paths)].sort();
    if (sorted.length !== paths.length || sorted.some((p, i) => p !== paths[i])) problems.push(`slice ${slice} is not sorted or has duplicates`);
    for (const path of paths) if (!entries.has(path)) problems.push(`slice ${slice} names a path the corpus does not have: ${path}`);
    // The slices that sync the shared-image case hold the shared image and every document that embeds it.
    const image = [...entries.values()].find((e) => e.role === "shared-image");
    if (image !== undefined && SHARED_IMAGE_SLICES.includes(slice)) {
      const inSlice = new Set(paths);
      const users = paths.filter((path) => {
        const entry = entries.get(path);
        return entry?.synced === true && entry.kind === "markdown" && entry.links.includes(image.path);
      }).length;
      if (!inSlice.has(image.path) || users !== SHARED_IMAGE_USERS) problems.push(`slice ${slice}: the shared image is embedded by ${users} documents, not ${SHARED_IMAGE_USERS}`);
    }
    // The mid slice keeps the documents its seed pins, and their linked files.
    if (slice === "mid") {
      const inSlice = new Set(paths);
      for (const path of midRegressions(manifest.seed)) {
        if (!inSlice.has(path)) problems.push(`slice mid leaves out the pinned document ${path}`);
        for (const target of entries.get(path)?.links ?? []) if (!inSlice.has(target)) problems.push(`slice mid leaves out ${target}, linked from the pinned document ${path}`);
      }
    }
  }

  const documents = [...entries.values()].filter((e) => e.synced && e.kind === "markdown").length;
  if (options.lint === true) {
    for (const problem of [...checkLintExpectations(root, manifest), ...checkLinearForm(root, manifest)]) {
      if (!problems.includes(problem)) problems.push(problem);
    }
  }
  return { problems, files: entries.size, documents, lfsBytes, nonLfsImages, groups };
}

function main(): void {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { git: { type: "boolean", default: false }, lint: { type: "boolean", default: false } } });
  const root = resolve(positionals[0] ?? ".");
  const result = checkCorpus(root, { git: values.git, lint: values.lint });
  for (const problem of result.problems) console.error(problem);
  const groups = Object.entries(result.groups).map(([g, n]) => `${g} ${n}`).join(", ");
  console.log(
    `${result.problems.length === 0 ? "corpus ok" : `corpus FAILED (${result.problems.length} problems)`}: ${result.files} files, ${result.documents} documents, ` +
      `${(result.lfsBytes / 1024 / 1024).toFixed(1)} MiB in LFS, ${result.nonLfsImages} images outside LFS; ${groups}`,
  );
  process.exitCode = result.problems.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

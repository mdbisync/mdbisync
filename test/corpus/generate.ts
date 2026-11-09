// Builds the test corpus from a seed and the fixture bank, and writes it as
// `corpus/` (the tree) and `corpus-slices/` (the slice lists and the
// manifest) under an output folder.
//
//   node test/corpus/generate.ts --hook-rev <release-sha> [--out <dir>] [--seed <text>] [--bank <dir>] [--replace]

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { makeAssets } from "./assets.ts";
import { copyBank } from "./bank.ts";
import { documents } from "./documents.ts";
import { fixText, linkedFileCheck } from "../../src/format/index.ts";
import { Canaries, isLfs, type CorpusFile } from "./model.ts";
import { Rng } from "./rng.ts";
import { makeSlices, MID_REGRESSIONS, SLICES, type Slice } from "./slices.ts";
import { BANK_HOME, treeFiles } from "./tree.ts";

export const DEFAULT_SEED = "corpus-v1";
const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BANK = resolve(here, "../fixtures");
export const DEFAULT_OUT = resolve(here, "out");

export type ManifestEntry = {
  path: string;
  group: string;
  kind: string;
  synced: boolean;
  lfs: boolean;
  bytes: number;
  canary: string | null;
  canary_in: "content" | "name" | null;
  class: string | null;
  rule: string | null;
  basis: string | null;
  macos_unsafe: boolean;
  bank_group: string | null;
  links: string[];
  note: string | null;
  role: string | null;
};

export type Manifest = {
  seed: string;
  files: ManifestEntry[];
  excluded: { file: string; reason: string }[];
};

export type Corpus = {
  files: CorpusFile[];
  manifest: Manifest;
  slices: Record<Slice, string[]>;
};

/**
 * A synchronized repository's tracked branch is already in the form Linear
 * stores, so every synced Markdown file is written through `fix`; the
 * lint-error files stay as they are, since `fix` never touches them.
 *
 * Forms that only exist outside Linear's form (CRLF, a final newline,
 * whitespace-only text, reference-style links) are rewritten here; the
 * fixture bank keeps them for the format tests. A rewritten file's note says
 * so. A bank copy classed fixable becomes unchanged; its basis stays known
 * only when the rewritten text is the form the probe recorded from Linear.
 */
export function inLinearForm(files: CorpusFile[], bankDir: string): void {
  const paths = new Set(files.map((file) => file.path));
  for (const file of files) {
    if (!file.synced || file.kind !== "markdown" || file.expected === "lint-error") continue;
    const text = file.content.toString("utf8");
    // As the fix command does: a link to a file the corpus does not have is not uploaded.
    const fixed = fixText(text, { linkedFileExists: linkedFileCheck(file.path, (path) => paths.has(path)) });
    if (fixed === text) continue;
    file.content = Buffer.from(fixed, "utf8");
    const rewritten = fixed === "" ? "written empty, as in Linear's form" : "written in Linear's form";
    file.note = file.note === null ? rewritten : `${file.note}; ${rewritten}`;
    if (file.expected === "fixable") {
      file.expected = "unchanged";
      // Known only when the probe recorded exactly this text as Linear's form; a generated file was never probed.
      const golden = file.bankGroup === null ? null : join(bankDir, `${file.path.slice(BANK_HOME.length + 1).replace(/\.md$/, "")}.linear.md`);
      if (!(golden !== null && existsSync(golden) && readFileSync(golden, "utf8") === fixed)) file.basis = "assumed";
    }
  }
}

export function buildCorpus(hookRevision: string, seed: string = DEFAULT_SEED, bankDir: string = DEFAULT_BANK): Corpus {
  const rng = new Rng(seed);
  const canaryRng = rng.fork("canaries");
  const canaries = new Canaries(() => canaryRng.hex(8));
  const bank = copyBank(bankDir, canaries);
  const tree = treeFiles(rng.fork("tree"), canaries, hookRevision);
  const assets = makeAssets(rng.fork("assets"));
  const taken = new Set<string>([...bank.files, ...tree, ...assets.files].map((f) => f.path));
  const docs = documents(rng.fork("documents"), canaries, assets, taken, bank.files);
  const files = [...bank.files, ...tree, ...assets.files, ...docs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  inLinearForm(files, bankDir);

  // Paths and links are checked on the files as written, after the rewrite above.
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) throw new Error(`two corpus files share the path ${file.path}`);
    seen.add(file.path);
  }
  for (const file of files) {
    for (const target of file.links) if (!seen.has(target)) throw new Error(`${file.path} links to ${target}, which is not in the corpus`);
  }

  const manifest: Manifest = {
    seed,
    files: files.map((f) => ({
      path: f.path,
      group: f.group,
      kind: f.kind,
      synced: f.synced,
      lfs: isLfs(f.path),
      bytes: f.content.length,
      canary: f.canary,
      canary_in: f.canaryIn,
      class: f.expected,
      rule: f.rule,
      basis: f.basis,
      macos_unsafe: f.macosUnsafe,
      bank_group: f.bankGroup,
      links: [...f.links].sort(),
      note: f.note,
      role: f.role ?? null,
    })),
    excluded: bank.excluded,
  };
  return { files, manifest, slices: makeSlices(files, rng.fork("slices"), MID_REGRESSIONS[seed] ?? []) };
}

/** Writes `corpus/` and `corpus-slices/` under the output folder. */
export function writeCorpus(corpus: Corpus, outDir: string, replace: boolean): void {
  const treeDir = join(outDir, "corpus");
  const slicesDir = join(outDir, "corpus-slices");
  for (const dir of [treeDir, slicesDir]) {
    if (existsSync(dir) && readdirSync(dir).length > 0) {
      if (!replace) throw new Error(`${dir} is not empty; pass --replace to regenerate it`);
      rmSync(dir, { recursive: true });
    }
  }
  for (const file of corpus.files) {
    const target = join(treeDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  mkdirSync(slicesDir, { recursive: true });
  for (const slice of SLICES) {
    writeFileSync(join(slicesDir, `${slice}.json`), `${JSON.stringify({ slice, paths: corpus.slices[slice] }, null, 2)}\n`);
  }
  writeFileSync(join(slicesDir, "manifest.json"), `${JSON.stringify(corpus.manifest, null, 2)}\n`);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      "hook-rev": { type: "string" },
      out: { type: "string", default: DEFAULT_OUT },
      seed: { type: "string", default: DEFAULT_SEED },
      bank: { type: "string", default: DEFAULT_BANK },
      replace: { type: "boolean", default: false },
    },
  });
  if (values["hook-rev"] === undefined) throw new Error("--hook-rev is required: pin a bundled release commit, not a source commit");
  const corpus = buildCorpus(values["hook-rev"], values.seed, values.bank);
  writeCorpus(corpus, resolve(values.out), values.replace);
  const lfsBytes = corpus.manifest.files.filter((f) => f.lfs).reduce((sum, f) => sum + f.bytes, 0);
  console.log(`corpus: ${corpus.files.length} files, ${(lfsBytes / 1024 / 1024).toFixed(1)} MiB in LFS, written to ${resolve(values.out)}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

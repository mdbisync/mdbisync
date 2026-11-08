// Builds the test corpus from a seed and the fixture bank, and writes it as
// `corpus/` (the tree) and `corpus-slices/` (the slice lists and the
// manifest) under an output folder.
//
//   node test/corpus/generate.ts [--out <dir>] [--seed <text>] [--bank <dir>] [--replace]

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { makeAssets } from "./assets.ts";
import { copyBank } from "./bank.ts";
import { documents } from "./documents.ts";
import { Canaries, isLfs, type CorpusFile } from "./model.ts";
import { Rng } from "./rng.ts";
import { makeSlices, SLICES, type Slice } from "./slices.ts";
import { treeFiles } from "./tree.ts";

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
  links: string[];
  note: string | null;
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

export function buildCorpus(seed: string = DEFAULT_SEED, bankDir: string = DEFAULT_BANK): Corpus {
  const rng = new Rng(seed);
  const canaryRng = rng.fork("canaries");
  const canaries = new Canaries(() => canaryRng.hex(8));
  const bank = copyBank(bankDir, canaries);
  const tree = treeFiles(rng.fork("tree"), canaries);
  const assets = makeAssets(rng.fork("assets"));
  const taken = new Set<string>([...bank.files, ...tree, ...assets.files].map((f) => f.path));
  const docs = documents(rng.fork("documents"), canaries, assets, taken);
  const files = [...bank.files, ...tree, ...assets.files, ...docs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

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
      links: [...f.links].sort(),
      note: f.note,
    })),
    excluded: bank.excluded,
  };
  return { files, manifest, slices: makeSlices(files, rng.fork("slices")) };
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
      out: { type: "string", default: DEFAULT_OUT },
      seed: { type: "string", default: DEFAULT_SEED },
      bank: { type: "string", default: DEFAULT_BANK },
      replace: { type: "boolean", default: false },
    },
  });
  const corpus = buildCorpus(values.seed, values.bank);
  writeCorpus(corpus, resolve(values.out), values.replace);
  const lfsBytes = corpus.manifest.files.filter((f) => f.lfs).reduce((sum, f) => sum + f.bytes, 0);
  console.log(`corpus: ${corpus.files.length} files, ${(lfsBytes / 1024 / 1024).toFixed(1)} MiB in LFS, written to ${resolve(values.out)}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

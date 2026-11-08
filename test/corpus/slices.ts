// The corpus slices: path lists that a scenario builds its starting tree
// from. Each list is closed: it holds the annotated README.md files above
// its documents, the files they embed or link, and the support files.

import { posix } from "node:path";
import { BANK_UNSYNCED } from "./bank.ts";
import { extension, isLfs, type CorpusFile } from "./model.ts";
import type { Rng } from "./rng.ts";
import { BANK_HOME, COLLISIONS, DOCS_PROJECTS, ENG_PROJECTS } from "./tree.ts";

export const SLICES = ["mini", "bank", "mid", "full"] as const;
export type Slice = (typeof SLICES)[number];

export const MINI_DOCUMENTS = 12;
export const MID_DOCUMENTS = 200;

const SUPPORT = [".gitattributes", ".pre-commit-config.yaml"];

function isDocument(file: CorpusFile): boolean {
  return file.synced && file.kind === "markdown";
}

/** Adds what the given paths need: annotation READMEs above them, linked files, support files. */
export function closure(files: CorpusFile[], paths: Iterable<string>): string[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out = new Set<string>(SUPPORT);
  // Every file added brings its own annotation READMEs and links, until nothing new is added.
  const pending = [...paths];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (out.has(path) && !SUPPORT.includes(path)) continue;
    const file = byPath.get(path);
    if (!file) throw new Error(`slice names a path the corpus does not have: ${path}`);
    out.add(path);
    for (let dir = posix.dirname(path); dir !== "."; dir = posix.dirname(dir)) {
      const readme = byPath.get(`${dir}/README.md`);
      if (readme && readme.group === "annotations" && !out.has(readme.path)) pending.push(readme.path);
    }
    for (const target of file.links) if (byPath.has(target) && !out.has(target)) pending.push(target);
  }
  return [...out].sort();
}

function pickMini(files: CorpusFile[]): string[] {
  const annotations = ["eng/README.md", "docs/README.md", `${ENG_PROJECTS[0]?.folder}/README.md`, `${ENG_PROJECTS[1]?.folder}/README.md`, `${DOCS_PROJECTS[0]?.folder}/README.md`];
  const homes = ["eng/backend/", "eng/frontend/", `${ENG_PROJECTS[0]?.folder}/`, `${ENG_PROJECTS[1]?.folder}/`, `${DOCS_PROJECTS[0]?.folder}/`];
  const candidates = files
    .filter((f) => isDocument(f) && f.group !== "annotations" && f.rule === null && f.content.length < 20_000)
    .filter((f) => homes.some((h) => f.path.startsWith(h)))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const picked: string[] = [];
  const take = (predicate: (f: CorpusFile) => boolean, what: string) => {
    const found = candidates.find((f) => predicate(f) && !picked.includes(f.path));
    if (!found) throw new Error(`no document for the mini slice: ${what}`);
    picked.push(found.path);
  };
  const linksTo = (f: CorpusFile, test: (target: string) => boolean) => f.links.some(test);
  take((f) => f.path.startsWith("eng/backend/") && linksTo(f, (t) => isLfs(t) && ["png", "jpg", "gif", "webp"].includes(extension(t))), "a team-zone document with an LFS image");
  take((f) => linksTo(f, (t) => !isLfs(t) && extension(t) === "png"), "a document with a non-LFS image");
  take((f) => linksTo(f, (t) => extension(t) === "pdf"), "a document linking a PDF");
  take((f) => f.group === "front-matter", "a document with front matter");
  for (const home of homes.slice(2)) take((f) => f.path.startsWith(home) && f.group === "work-documents", `a document in ${home}`);
  const documents = [...annotations, ...picked];
  if (documents.length !== MINI_DOCUMENTS) throw new Error(`the mini slice has ${documents.length} documents, not ${MINI_DOCUMENTS}`);
  return documents;
}

function pickMid(files: CorpusFile[], rng: Rng): string[] {
  // Colliding names only make sense as a pair and cannot be checked out on
  // macOS, so they stay in the bank and full slices.
  const documents = files
    .filter((f) => isDocument(f) && f.group !== "annotations" && !f.macosUnsafe)
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const groups = [...new Set(documents.map((f) => f.group))].sort();
  // Every group gets at least two documents, the rest in proportion to size.
  const share = new Map(groups.map((g) => [g, 2]));
  let left = MID_DOCUMENTS - groups.length * 2;
  const sizes = new Map(groups.map((g) => [g, documents.filter((f) => f.group === g).length]));
  const total = documents.length;
  for (const g of groups) {
    const extra = Math.min(left, Math.floor(((sizes.get(g) as number) * (MID_DOCUMENTS - groups.length * 2)) / total));
    share.set(g, (share.get(g) as number) + extra);
    left -= extra;
  }
  for (const g of [...groups].sort((a, b) => (sizes.get(b) as number) - (sizes.get(a) as number))) {
    if (left === 0) break;
    share.set(g, (share.get(g) as number) + 1);
    left--;
  }
  const picked: string[] = [];
  for (const g of groups) {
    const pool = rng.shuffle(documents.filter((f) => f.group === g));
    picked.push(...pool.slice(0, share.get(g)).map((f) => f.path));
  }
  if (picked.length !== MID_DOCUMENTS) throw new Error(`the mid slice has ${picked.length} documents, not ${MID_DOCUMENTS}`);
  return picked;
}

export function makeSlices(files: CorpusFile[], rng: Rng): Record<Slice, string[]> {
  const bank = files
    .filter((f) => f.path.startsWith(`${BANK_HOME}/`) || f.path.startsWith(`${COLLISIONS}/`) || f.path.startsWith(`${BANK_UNSYNCED}/`))
    .filter((f) => f.path !== `${BANK_HOME}/README.md`)
    .map((f) => f.path);
  return {
    mini: closure(files, pickMini(files)),
    bank: closure(files, bank),
    mid: closure(files, pickMid(files, rng)),
    full: files.map((f) => f.path).sort(),
  };
}

// Copies the fixture bank into the corpus: every fixture is a construct
// single, keeping the bank's group, class, rule and canary.

import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse } from "yaml";
import { kindOf, type Canaries, type CorpusFile, type Expected } from "./model.ts";
import { BANK_HOME, COLLISIONS, LOOSE } from "./tree.ts";

type BankEntry = {
  file: string;
  group?: string;
  construct?: string;
  class?: Expected;
  rule?: string;
  basis?: "known" | "assumed";
  canary?: string;
  canary_in?: "name";
  synced?: boolean;
  name_as?: string;
  macos_unsafe?: boolean;
};

type BankIndex = { assets?: BankEntry[]; fixtures: BankEntry[] };

/** Where the bank's unsynced folder goes: above every annotation. */
export const BANK_UNSYNCED = `${LOOSE}/bank-unsynced`;

export type BankCopy = {
  files: CorpusFile[];
  /** Bank files left out of the corpus, with the reason. */
  excluded: { file: string; reason: string }[];
};

function corpusPath(entry: BankEntry): string {
  if (entry.name_as !== undefined) return `${COLLISIONS}/${entry.name_as}`;
  if (entry.file.startsWith("unsynced/")) return `${BANK_UNSYNCED}/${entry.file.slice("unsynced/".length)}`;
  return `${BANK_HOME}/${entry.file}`;
}

/** Relative link targets in Markdown text, outside code. */
function linkTargets(text: string): string[] {
  const withoutCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const targets: string[] = [];
  for (const m of withoutCode.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)/g)) {
    let target = m[1] as string;
    if (target.startsWith("<")) target = target.slice(1, -1);
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
    targets.push(decodeURI(target.split("#")[0] as string));
  }
  return targets;
}

export function copyBank(bankDir: string, canaries: Canaries): BankCopy {
  const index = parse(readFileSync(join(bankDir, "index.yaml"), "utf8")) as BankIndex;
  const excluded: BankCopy["excluded"] = [];
  const entries = index.fixtures.filter((entry) => {
    // Only .md files are synchronized, so a duplicate-title pair needs two
    // .md names; the bank marks the colliding name with name_as.
    if (entry.rule === "duplicate-title" && entry.name_as === undefined) {
      excluded.push({ file: entry.file, reason: "duplicate-title fixture without name_as: not a collision when only .md is synced" });
      return false;
    }
    return true;
  });
  const placed = new Map<string, string>(); // bank file -> corpus path
  for (const entry of [...entries, ...(index.assets ?? [])]) placed.set(entry.file, corpusPath(entry));

  const files: CorpusFile[] = [];
  for (const entry of entries) {
    const path = placed.get(entry.file) as string;
    let content = readFileSync(join(bankDir, entry.file));
    let note: string | null = null;
    const links: string[] = [];
    if (kindOf(entry.file) === "markdown") {
      let text = content.toString("utf8");
      for (const target of linkTargets(text)) {
        const bankTarget = posix.normalize(posix.join(posix.dirname(entry.file), target));
        const corpusTarget = placed.get(bankTarget);
        if (corpusTarget === undefined) continue; // a broken link on purpose, or a link outside the bank
        links.push(corpusTarget);
        const expectedHere = posix.relative(posix.dirname(path), corpusTarget);
        if (expectedHere !== target) {
          text = text.split(`](${target})`).join(`](${expectedHere})`);
          note = "link rewritten to the corpus layout";
        }
      }
      if (note !== null) content = Buffer.from(text, "utf8");
    }
    if (entry.canary !== undefined) canaries.reserve(entry.canary);
    files.push({
      path,
      content,
      group: entry.synced === false ? "unsynced" : "construct-singles",
      kind: kindOf(path),
      synced: entry.synced !== false && kindOf(path) === "markdown",
      canary: entry.canary ?? null,
      canaryIn: entry.canary_in === "name" ? "name" : entry.canary === undefined ? null : "content",
      expected: entry.class ?? null,
      rule: entry.rule ?? null,
      basis: entry.basis ?? null,
      macosUnsafe: entry.macos_unsafe === true,
      links,
      note,
    });
  }
  for (const asset of index.assets ?? []) {
    const path = placed.get(asset.file) as string;
    files.push({
      path,
      content: readFileSync(join(bankDir, asset.file)),
      group: kindOf(path) === "image" ? "images" : "attachments",
      kind: kindOf(path),
      synced: false,
      canary: null,
      canaryIn: null,
      expected: null,
      rule: null,
      basis: null,
      macosUnsafe: false,
      links: [],
      note: "fixture bank asset",
    });
  }
  return { files, excluded };
}

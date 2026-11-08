// Copies the fixture bank into the corpus. Every synced fixture counts as a
// construct single in the corpus composition; the manifest keeps its bank
// group, class, rule, basis and canary.

import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse } from "yaml";
import { destination, kindOf, type Canaries, type CorpusFile, type Expected } from "./model.ts";
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
  // name_as is the colliding path within the bank; both names of a pair share
  // a folder there, so their file names collide in the collisions folder too.
  if (entry.name_as !== undefined) return `${COLLISIONS}/${posix.basename(entry.name_as)}`;
  if (entry.file.startsWith("unsynced/")) return `${BANK_UNSYNCED}/${entry.file.slice("unsynced/".length)}`;
  return `${BANK_HOME}/${entry.file}`;
}

/** A relative link target as written, and the form it is written in. */
export type Target = { written: string; form: "inline" | "definition" | "html" };

/**
 * Relative link targets in Markdown text, outside code: inline links and
 * images, reference definitions (`[label]: target`), which reference-style
 * links and images resolve to, and HTML `src` and `href` attributes.
 * Footnote definitions (`[^1]: text`) are not links.
 */
export function linkTargets(text: string): Target[] {
  const withoutCode = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const found: Target[] = [];
  for (const m of withoutCode.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)/g)) found.push({ written: m[1] as string, form: "inline" });
  for (const m of withoutCode.matchAll(/^ {0,3}\[(?!\^)[^\]]+\]:[ \t]*(<[^>]*>|\S+)/gm)) found.push({ written: m[1] as string, form: "definition" });
  for (const m of withoutCode.matchAll(/<[a-z][^>]*?\s(?:src|href)\s*=\s*"([^"]*)"/gi)) found.push({ written: m[1] as string, form: "html" });
  return found.filter(({ written }) => {
    const target = bare(written);
    return target !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#") && !target.startsWith("/");
  });
}

/** The target without angle brackets. */
function bare(written: string): string {
  return written.startsWith("<") && written.endsWith(">") ? written.slice(1, -1) : written;
}

/** The file part of a target, percent-decoded; a malformed escape is kept as written. */
export function targetPath(written: string): string {
  const [file] = bare(written).split("#") as [string];
  try {
    return decodeURI(file);
  } catch {
    return file;
  }
}

/** The anchor of a target, with its "#", or "". */
function anchor(written: string): string {
  const i = bare(written).indexOf("#");
  return i < 0 ? "" : bare(written).slice(i);
}

/** Rewrites one link target in the text; replacement text is taken literally. */
export function rewrite(text: string, target: Target, replacement: string): string {
  const escaped = target.written.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  switch (target.form) {
    case "inline":
      return text.replace(new RegExp(`\\]\\(\\s*${escaped}`, "g"), () => `](${destination(replacement)}`);
    case "definition":
      return text.replace(new RegExp(`^( {0,3}\\[(?!\\^)[^\\]]+\\]:[ \\t]*)${escaped}`, "gm"), (_m, head: string) => `${head}${destination(replacement)}`);
    case "html":
      return text.replace(new RegExp(`(\\s(?:src|href)\\s*=\\s*")${escaped}"`, "gi"), (_m, head: string) => `${head}${encodeURI(replacement)}"`);
  }
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
        const bankTarget = posix.normalize(posix.join(posix.dirname(entry.file), targetPath(target.written)));
        const corpusTarget = placed.get(bankTarget);
        if (corpusTarget === undefined) continue; // a broken link on purpose, or a link outside the bank
        links.push(corpusTarget);
        // Rewrite only when the link, as written, no longer reaches its file.
        const reachedNow = posix.normalize(posix.join(posix.dirname(path), targetPath(target.written)));
        if (reachedNow !== corpusTarget) {
          text = rewrite(text, target, `${posix.relative(posix.dirname(path), corpusTarget)}${anchor(target.written)}`);
          note = "link rewritten to the corpus layout";
        }
      }
      if (note !== null) content = Buffer.from(text, "utf8");
    }
    if (entry.canary !== undefined) canaries.reserve(entry.canary);
    // Files placed above every annotation are never synchronized, whatever the bank says.
    const synced = entry.synced !== false && !path.startsWith(`${LOOSE}/`) && kindOf(path) === "markdown";
    files.push({
      path,
      content,
      group: synced ? "construct-singles" : "unsynced",
      bankGroup: entry.group ?? null,
      kind: kindOf(path),
      synced,
      canary: entry.canary ?? null,
      canaryIn: entry.canary_in === "name" ? "name" : entry.canary === undefined ? null : "content",
      expected: entry.class ?? null,
      rule: entry.rule ?? null,
      basis: entry.basis ?? null,
      macosUnsafe: entry.macos_unsafe === true,
      links: [...new Set(links)],
      note,
    });
  }
  for (const asset of index.assets ?? []) {
    const path = placed.get(asset.file) as string;
    files.push({
      path,
      content: readFileSync(join(bankDir, asset.file)),
      group: kindOf(path) === "image" ? "images" : "attachments",
      bankGroup: "assets",
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

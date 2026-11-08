// Shared types and rules of the test corpus.

import { posix } from "node:path";

export type Kind = "markdown" | "image" | "attachment" | "other";
export type Expected = "fixable" | "lint-error" | "unchanged";

/** One file of the generated corpus, with what tests need to know about it. */
export type CorpusFile = {
  /** Path relative to the corpus root, with "/" separators. */
  path: string;
  content: Buffer;
  group: Group;
  kind: Kind;
  /** False for files above every annotation and non-Markdown files. */
  synced: boolean;
  /** The file's unique canary token, or null for files that cannot hold one. */
  canary: string | null;
  /** "name" when the canary is in the file name because the file holds no text. */
  canaryIn: "content" | "name" | null;
  expected: Expected | null;
  rule: string | null;
  basis: "known" | "assumed" | null;
  /** True when the name collides with another on case- or normalization-insensitive file systems. */
  macosUnsafe: boolean;
  /** Corpus paths this file links to or embeds (documents, images, attachments). */
  links: string[];
  note: string | null;
};

export const GROUPS = [
  "annotations",
  "construct-singles",
  "pairwise",
  "work-documents",
  "size-spectrum",
  "mermaid",
  "tables",
  "typography-scripts",
  "links",
  "front-matter",
  "html-extensions",
  "conflict-markers",
  "lint-errors",
  "images",
  "attachments",
  "unsynced",
  "support",
] as const;
export type Group = (typeof GROUPS)[number];

/** Minimum number of files per group in the corpus. */
export const MINIMUMS: Partial<Record<Group, number>> = {
  "construct-singles": 200,
  pairwise: 300,
  "work-documents": 800,
  "size-spectrum": 50,
  mermaid: 60,
  tables: 120,
  "typography-scripts": 120,
  links: 80,
  "front-matter": 60,
  "html-extensions": 100,
  "conflict-markers": 10,
  "lint-errors": 30,
  images: 350,
  attachments: 60,
  unsynced: 40,
};

export const MIN_TOTAL_FILES = 2000;
export const MAX_LFS_BYTES = 300 * 1024 * 1024;
export const MAX_NON_LFS_IMAGES = 50;
/** Linear rejects documents over this many characters. */
export const CONTENT_LIMIT = 250_000;
/** Linear's upload limit on the free plan. */
export const UPLOAD_LIMIT = 10 * 1024 * 1024;

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"];
export const ATTACHMENT_EXTENSIONS = ["pdf", "woff2", "ttf", "otf", "zip", "csv", "json", "mp4", "mp3", "txt"];

/** Extensions stored in Git LFS anywhere in the tree. */
export const LFS_EXTENSIONS = [...IMAGE_EXTENSIONS, "pdf", "woff2", "ttf", "otf", "zip", "mp4", "mp3"];
/** Folders whose files are all stored in LFS, whatever the extension. */
export const LFS_FOLDER = "media";
/** Folders whose files are never stored in LFS: the small non-LFS image set. */
export const NON_LFS_FOLDER = "inline";

export function extension(path: string): string {
  const base = posix.basename(path);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Whether a path goes to LFS under the rules that .gitattributes encodes. */
export function isLfs(path: string): boolean {
  const segments = path.split("/").slice(0, -1);
  if (segments.includes(NON_LFS_FOLDER)) return false;
  if (segments.includes(LFS_FOLDER)) return true;
  return LFS_EXTENSIONS.includes(extension(path));
}

export function gitattributes(): string {
  const lfs = "filter=lfs diff=lfs merge=lfs -text";
  return [
    "# Corpus files are byte-exact test data: no line-ending conversion, whatever core.autocrlf says.",
    "* -text",
    "# Images and attachments are stored in Git LFS, by extension and by folder.",
    ...LFS_EXTENSIONS.flatMap((ext) => [`*.${ext} ${lfs}`, `*.${ext.toUpperCase()} ${lfs}`]),
    `**/${LFS_FOLDER}/** ${lfs}`,
    "# A small set of tiny images stays in plain git.",
    `**/${NON_LFS_FOLDER}/** -filter -diff -merge -text`,
    "",
  ].join("\n");
}

export function kindOf(path: string): Kind {
  const ext = extension(path);
  if (ext === "md") return "markdown";
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (ATTACHMENT_EXTENSIONS.includes(ext)) return "attachment";
  return "other";
}

/** Corpus-relative link from one file to another, as written in Markdown. */
export function relativeLink(from: string, to: string): string {
  const rel = posix.relative(posix.dirname(from), to);
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** A Markdown link destination; angle brackets keep spaces and parentheses intact. */
export function destination(target: string): string {
  return /[\s()<>]/.test(target) ? `<${target}>` : target;
}

export const CANARY = /kx-[0-9a-f]{8}/;

/** Hands out unique canary tokens from a seeded source. */
export class Canaries {
  #used = new Set<string>();
  #next: () => string;

  constructor(next: () => string) {
    this.#next = next;
  }

  /** Reserves a token that already exists (a fixture's own). */
  reserve(token: string): void {
    if (this.#used.has(token)) throw new Error(`canary ${token} is used twice`);
    this.#used.add(token);
  }

  take(): string {
    for (;;) {
      const token = `kx-${this.#next()}`;
      if (!this.#used.has(token)) {
        this.#used.add(token);
        return token;
      }
    }
  }
}

export function markdownFile(fields: Partial<CorpusFile> & Pick<CorpusFile, "path" | "content" | "group">): CorpusFile {
  return {
    kind: kindOf(fields.path),
    synced: true,
    canary: null,
    canaryIn: null,
    expected: null,
    rule: null,
    basis: null,
    macosUnsafe: false,
    links: [],
    note: null,
    ...fields,
  };
}

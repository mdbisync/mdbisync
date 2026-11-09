// Conflict markers as the sync writes them, and the paragraph-level edits
// that scenarios use to make or avoid conflicts.
//
// A conflict is three marker paragraphs around the two versions; the sync
// finds them by exact line match, and so does the harness:
//
//   **Sync conflict: git version**
//   <the tracked branch's version>
//   **Sync conflict: Linear version**
//   <Linear's version>
//   **Sync conflict: end**

export const MARKERS = {
  git: '**Sync conflict: git version**',
  linear: '**Sync conflict: Linear version**',
  end: '**Sync conflict: end**',
} as const;
export type MarkerKind = keyof typeof MARKERS;

/** The conflict mark a conflicted document carries in Linear. */
export const CONFLICT_MARK = { icon: 'Alert', color: 'orange' } as const;

/**
 * Linear stores a color as a hex code; specs speak of the palette's names.
 * The harness keeps its own table (not the engine's constants), so a wrong
 * color in the engine still shows.
 */
export const PALETTE: Readonly<Record<string, string>> = {
  '#f2994a': 'orange',
  '#eb5757': 'red',
  '#f2c94c': 'yellow',
  '#4cb782': 'green',
  '#4ea7fc': 'blue',
  '#5e6ad2': 'indigo',
  '#bb87fc': 'purple',
  '#95a2b3': 'gray',
};

/** A document color as specs name it: the palette name for a known hex code, else the value as Linear has it. */
export function colorLabel(color: string | null | undefined): string | null {
  if (color === null || color === undefined) return null;
  return PALETTE[color.toLowerCase()] ?? color;
}
/** The mark of a document a security hook blocked. */
export const BLOCKED_MARK = { icon: 'Cross', color: 'red' } as const;

export interface MarkerSet {
  /** Marker kinds present, in order. */
  kinds: MarkerKind[];
  /** The text between the git and Linear markers (empty when either is missing). */
  git: string;
  /** The text between the Linear and end markers (empty when either is missing). */
  linear: string;
}

export interface MarkerScan {
  sets: MarkerSet[];
  /** Marker lines in the text. */
  markerLines: number;
  /** Sets that start inside another open set. */
  nested: number;
}

function lines(text: string): string[] {
  return text.split('\n').map((line) => line.replace(/\r$/, ''));
}

function kindOf(line: string): MarkerKind | null {
  for (const kind of Object.keys(MARKERS) as MarkerKind[]) if (line === MARKERS[kind]) return kind;
  return null;
}

/**
 * Groups the marker lines of a text into sets. A set starts at a git marker,
 * or at a Linear or end marker that cannot belong to the set before it; a
 * partial set (a marker line removed) still counts as one set.
 */
export function scanMarkers(text: string): MarkerScan {
  const all = lines(text);
  const sets: Array<MarkerSet & { at: Partial<Record<MarkerKind, number>> }> = [];
  let nested = 0;
  let markerLines = 0;
  // Marker lines inside a code fence are lookalikes: a real conflict takes in whole fences.
  let fence: string | null = null;
  for (const [index, line] of all.entries()) {
    const opener = /^(```+|~~~+)/.exec(line)?.[1];
    if (opener !== undefined) {
      if (fence === null) fence = opener;
      else if (line.startsWith(fence) && line.trim() === line.trim().replace(/[^`~]/g, '')) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const kind = kindOf(line);
    if (kind === null) continue;
    markerLines += 1;
    const open = sets.at(-1);
    const fits = open !== undefined && !open.kinds.includes(kind) && (kind !== 'git' ? !open.kinds.includes('end') : false);
    if (kind === 'git' && open !== undefined && open.kinds.includes('git') && !open.kinds.includes('end')) nested += 1;
    if (fits && open !== undefined) {
      open.kinds.push(kind);
      open.at[kind] = index;
    } else {
      sets.push({ kinds: [kind], git: '', linear: '', at: { [kind]: index } });
    }
  }
  const between = (from: number | undefined, to: number | undefined) =>
    from === undefined || to === undefined ? '' : all.slice(from + 1, to).join('\n').replace(/^\n+|\n+$/g, '');
  return {
    sets: sets.map(({ kinds, at }) => ({ kinds, git: between(at.git, at.linear), linear: between(at.linear, at.end) })),
    markerLines,
    nested,
  };
}

export function inConflict(text: string): boolean {
  return scanMarkers(text).markerLines > 0;
}

/** Removes every marker set, keeping one side's version. */
export function resolveKeeping(text: string, side: 'git' | 'linear'): string {
  const all = lines(text);
  const out: string[] = [];
  let state: 'outside' | MarkerKind = 'outside';
  let fence: string | null = null;
  for (const line of all) {
    // Marker lines inside a code fence are text (lookalikes), as scanMarkers treats them.
    const opener = /^(```+|~~~+)/.exec(line)?.[1];
    if (opener !== undefined) fence = fence === null ? opener : line.startsWith(fence) ? null : fence;
    const kind = fence !== null || opener !== undefined ? null : kindOf(line);
    if (kind !== null) {
      state = kind === 'end' ? 'outside' : kind;
      continue;
    }
    if (state === 'outside' || state === side) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n');
}

// --- blocks and paragraphs ---------------------------------------------------

export type BlockKind = 'paragraph' | 'heading' | 'fence' | 'table' | 'ordered-list' | 'nested-list' | 'bullet-list' | 'quote' | 'image' | 'front-matter' | 'marker' | 'other';

/** The kind of a block of Markdown (text between blank lines). */
export function blockKind(block: string): BlockKind {
  const [first = '', ...rest] = block.split('\n');
  if (kindOf(first) !== null) return 'marker';
  if (first === '---') return 'front-matter';
  if (/^(```|~~~)/.test(first)) return 'fence';
  if (/^#{1,6}\s/.test(first)) return 'heading';
  if (/^\|/.test(first)) return 'table';
  if (/^\d+[.)]\s/.test(first)) return 'ordered-list';
  if (/^[-*+]\s/.test(first)) return rest.some((line) => /^\s+([-*+]|\d+[.)])\s/.test(line)) ? 'nested-list' : 'bullet-list';
  if (/^>/.test(first)) return 'quote';
  if (/^!\[[^\]]*\]\([^)]*\)\s*$/.test(first) && rest.length === 0) return 'image';
  if (/^</.test(first)) return 'other';
  return 'paragraph';
}

/** Splits a text into blocks and the separators between them, so `join` gives it back exactly. */
export function splitBlocks(text: string): { blocks: string[]; separators: string[] } {
  const parts = text.split(/(\n{2,})/);
  const blocks: string[] = [];
  const separators: string[] = [];
  parts.forEach((part, index) => (index % 2 === 0 ? blocks.push(part) : separators.push(part)));
  return { blocks, separators };
}

export function joinBlocks(blocks: readonly string[], separators: readonly string[]): string {
  return blocks.map((block, index) => (index < separators.length ? `${block}${separators[index]}` : block)).join('');
}

/** Indexes of plain paragraphs (not headings, lists, tables, fences, quotes, images or markers). */
export function paragraphIndexes(text: string): number[] {
  return splitBlocks(text).blocks.flatMap((block, index) => (block.trim() !== '' && blockKind(block) === 'paragraph' ? [index] : []));
}

/** A sentence that carries an edit token. */
export function noteSentence(token: string): string {
  return `The review moved to the next morning, note ${token}.`;
}

/**
 * Adds a sentence with `token` to the end of the n-th plain paragraph (0-based).
 * A document with fewer paragraphs gets a new paragraph at its end.
 */
export function editParagraph(text: string, ordinal: number, token: string): string {
  const { blocks, separators } = splitBlocks(text);
  const index = paragraphIndexes(text)[ordinal];
  if (index === undefined) return `${text.replace(/\n*$/, '\n')}\n${noteSentence(token)}\n`;
  blocks[index] = `${(blocks[index] as string).replace(/\s+$/, '')} ${noteSentence(token)}`;
  return joinBlocks(blocks, separators);
}

/** Changes the first block that `match` accepts: `change` gets the block's lines and returns new ones; null when none matches. */
export function editBlock(text: string, match: (block: string, kind: BlockKind) => boolean, change: (lines: string[]) => string[]): string | null {
  const { blocks, separators } = splitBlocks(text);
  const index = blocks.findIndex((block) => match(block, blockKind(block)));
  if (index < 0) return null;
  blocks[index] = change((blocks[index] as string).split('\n')).join('\n');
  return joinBlocks(blocks, separators);
}

/** Ordinal targets in specs: first-paragraph → 0, second-document → 1. */
export function ordinalOf(target: unknown): number | null {
  if (typeof target !== 'string') return null;
  const match = /^(first|second|third|fourth|fifth)-/.exec(target);
  return match === null ? null : ['first', 'second', 'third', 'fourth', 'fifth'].indexOf(match[1] as string);
}

// --- what a conflict covers ---------------------------------------------------

export type ConflictScope = 'none' | 'paragraph' | 'whole-table' | 'whole-fence' | 'whole-list' | 'line' | 'image-links';

/** What the versions of a marker set hold, by the kind of their blocks. */
export function scopeOfSet(set: MarkerSet): ConflictScope {
  const kinds = new Set<BlockKind>();
  for (const version of [set.git, set.linear]) for (const block of splitBlocks(version).blocks) if (block.trim() !== '') kinds.add(blockKind(block));
  const imageOnly = [set.git, set.linear].every((version) => /!\[[^\]]*\]\([^)]+\)/.test(version));
  if (imageOnly && [...kinds].every((kind) => kind === 'image' || kind === 'paragraph')) return 'image-links';
  if (kinds.has('table')) return 'whole-table';
  if (kinds.has('fence')) return 'whole-fence';
  if (kinds.has('ordered-list') || kinds.has('nested-list')) return 'whole-list';
  if (kinds.has('bullet-list') && [set.git, set.linear].every((version) => version.split('\n').length === 1)) return 'line';
  return 'paragraph';
}

/** The scope of a text's conflict: `none` without markers, else the scope of its sets (the first when they differ). */
export function conflictScope(text: string): ConflictScope {
  const { sets } = scanMarkers(text);
  return sets.length === 0 ? 'none' : scopeOfSet(sets[0] as MarkerSet);
}

/** Whether a version is a whole block: tables with their header and separator, closed fences, lists from their first item. */
export function versionComplete(version: string): boolean {
  if (version.trim() === '') return false;
  for (const block of splitBlocks(version).blocks) {
    const kind = blockKind(block);
    const blockLines = block.split('\n');
    if (kind === 'table' && !(blockLines.length >= 2 && /^\|?\s*:?-+/.test(blockLines[1] ?? ''))) return false;
    if (kind === 'fence' && !/^(```|~~~)\s*$/.test(blockLines.at(-1) ?? '')) return false;
  }
  const fenceLines = version.split('\n').filter((line) => /^(```|~~~)/.test(line)).length;
  if (fenceLines % 2 !== 0) return false;
  const first = version.split('\n').find((line) => line.trim() !== '') ?? '';
  return !/^\s+([-*+]|\d+[.)])\s/.test(first);
}

/** Every set has both versions and each is a whole block. */
export function bothVersionsComplete(text: string): boolean {
  const { sets } = scanMarkers(text);
  return sets.length > 0 && sets.every((set) => set.kinds.length === 3 && versionComplete(set.git) && versionComplete(set.linear));
}

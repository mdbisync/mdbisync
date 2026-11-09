// Checks after a scenario: the invariants I1 to I9 of every scenario and the
// scenario's own assertions. A check reports what failed in words and paths,
// never document content.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { LinearClient, LinearDocument } from '../../../src/linear/index.ts';
import type { Definition, Image, Link, Nodes } from 'mdast';
import { parse, splitFile, visit } from '../../../src/format/markdown.ts';
import { UPLOAD_TOO_LARGE, UPLOAD_UNREADABLE } from '../../../src/initial-sync/uploads.ts';
import { readIds, readUploads, resolveStateConfig, stateRef, type Git, type IdMap } from '../../../src/state/index.ts';
import type { RunContext } from './context.ts';
import { annotatedFolders, owningFolder, type Folder } from './corpus.ts';
import type { EngineResult } from './engine.ts';
import { HarnessGapError, NotImplementedError, ProductError, type CheckOutcome } from './results.ts';
import { INVARIANTS, type Assertion, type InvariantId } from './spec.ts';
import { encodeTitlePath, expectedPlace, placeOf, refreshView, resolveSubject, shortSegment } from './subjects.ts';

// --- pure helpers ----------------------------------------------------------

/**
 * The body of a file as the engine sends it to Linear: without a byte order
 * mark, front matter and the blank lines after it, by the engine's own rule.
 */
export function bodyOf(text: string): string {
  return splitFile(text).body;
}

/** Where a mapped id's document is: in use, in the trash, archived (with its project), or gone. */
export function documentState(document: Pick<LinearDocument, 'trashed' | 'archivedAt'> | undefined): 'active' | 'trashed' | 'archived' | 'missing' {
  if (document === undefined) return 'missing';
  if (document.trashed) return 'trashed';
  return document.archivedAt === null || document.archivedAt === undefined ? 'active' : 'archived';
}

/** The Linear title of a synchronized file: its path below its annotated folder, without `.md`. */
export function titleOf(path: string, folderOfPath: string): string {
  const relative = folderOfPath === '' ? path : path.slice(folderOfPath.length + 1);
  return relative.replace(/\.md$/, '');
}

/**
 * Whether a file name below its annotated folder (`titleOf`'s result) is one
 * the documented path rule gives the document with this title and id: the
 * title as it is (an existing git spelling the rule keeps), its encoded path
 * (`encodeTitlePath`), or its collision name directly in the folder: the
 * encoded title with `/` flattened to `%2F` (cut like a long segment, hashing
 * the title, past 180 bytes), `~`, the first twelve hex digits of
 * SHA-256(document id) and an optional `-` and digits. A collision name made
 * from another document's id, or one placed in a subfolder, does not fit.
 * Whether the folder is the document's own place is I7's separate check.
 */
export function pathFitsTitle(stem: string, title: string, id: string): boolean {
  const encoded = encodeTitlePath(title);
  if (stem === title || stem === encoded) return true;
  const collision = `${shortSegment(encoded.replaceAll('/', '%2F'), title)}~${createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
  return stem === collision || (stem.startsWith(`${collision}-`) && /^\d+$/.test(stem.slice(collision.length + 1)));
}


/**
 * The repository file a relative link destination points to, with its
 * fragment; undefined for an external URL, an anchor in the same document, a
 * query, or a path above the repository. A leading `/` is the repository root.
 */
export function linkedFile(fromPath: string, destination: string): { path: string; fragment: string | undefined } | undefined {
  if (destination === '' || destination.startsWith('#') || destination.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(destination)) return undefined;
  const hash = destination.indexOf('#');
  const target = hash === -1 ? destination : destination.slice(0, hash);
  if (target === '' || target.includes('?')) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return undefined;
  }
  const path = posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(posix.dirname(fromPath), decoded));
  if (path === '.' || path === '..' || path.startsWith('../') || path.endsWith('/')) return undefined;
  return { path, fragment: hash === -1 ? undefined : destination.slice(hash + 1) };
}

/** What a file's links become in Linear. */
export interface LinkTargets {
  /** Every tracked file's SHA-256 by path, and the upload URL of each uploaded hash. */
  hashes: ReadonlyMap<string, string>;
  uploadsByHash: ReadonlyMap<string, string>;
  /** Synchronized documents by path, and the URL prefix their links use. */
  ids?: ReadonlyMap<string, { id: string }>;
  documentUrlBase?: string;
}

/** A link, image or definition destination in a Markdown body. */
export interface Destination {
  /** Offsets of the raw destination, angle brackets included. */
  from: number;
  to: number;
  /** The destination as the parser reads it (escapes and entities resolved). */
  url: string;
  /** An image, or a definition only images use. */
  image: boolean;
}

/** Where a node's destination sits: after the `](` that ends its text, or after a definition's `]:`. */
function destinationSpan(body: string, node: Link | Image | Definition): { from: number; to: number } | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return undefined;
  let at: number;
  if (node.type === 'definition') {
    let close = start + 1;
    while (close < end && body[close] !== ']') close += body[close] === '\\' ? 2 : 1;
    if (body[close + 1] !== ':') return undefined;
    at = close + 2;
  } else {
    // Autolinks and bare URLs have no `](`.
    if (body[end - 1] !== ')') return undefined;
    const textEnd = node.type === 'link' ? (node.children.at(-1)?.position?.end.offset ?? start + 1) : start + 2;
    const open = body.indexOf('](', textEnd);
    if (open === -1 || open >= end) return undefined;
    at = open + 2;
  }
  while (at < end && /[ \t\r\n]/.test(body[at] as string)) at += 1;
  if (body[at] === '<') {
    let close = at + 1;
    while (close < end && body[close] !== '>') close += body[close] === '\\' ? 2 : 1;
    return close < end ? { from: at, to: close + 1 } : undefined;
  }
  let to = at;
  let depth = 0;
  while (to < end) {
    const char = body[to] as string;
    if (char === '\\') to += 2;
    else if (/[ \t\r\n]/.test(char)) break;
    else if (char === '(') {
      depth += 1;
      to += 1;
    } else if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
      to += 1;
    } else to += 1;
  }
  return to > at ? { from: at, to } : undefined;
}

/**
 * Every link, image and definition destination of a Markdown body, in text
 * order, as the Markdown parser finds them: nothing inside code, and labels
 * of any form.
 */
export function linkDestinations(body: string): Destination[] {
  const tree = parse(body);
  const imageLabels = new Set<string>();
  const linkLabels = new Set<string>();
  visit(tree, (node: Nodes) => {
    if (node.type === 'imageReference') imageLabels.add(node.identifier);
    if (node.type === 'linkReference') linkLabels.add(node.identifier);
  });
  const found: Destination[] = [];
  visit(tree, (node: Nodes) => {
    if (node.type !== 'link' && node.type !== 'image' && node.type !== 'definition') return;
    const span = destinationSpan(body, node);
    if (span === undefined) return;
    const image = node.type === 'image' || (node.type === 'definition' && imageLabels.has(node.identifier) && !linkLabels.has(node.identifier));
    found.push({ ...span, url: node.url, image });
  });
  return found.sort((a, b) => a.from - b.from);
}

/** What a fragment cannot hold as it is in a link destination, percent-encoded. */
function encodeFragment(fragment: string): string {
  return fragment.replace(/[^A-Za-z0-9\-._~!$'*+,;=:@/?%]/g, (char) => encodeURIComponent(char));
}

/** Replaces destinations by offset; `replace` returns the new raw destination, or undefined to keep it. */
function rewriteDestinations(body: string, replace: (destination: Destination) => string | undefined): string {
  let result = '';
  let at = 0;
  for (const destination of linkDestinations(body)) {
    const next = replace(destination);
    if (next === undefined) continue;
    result += body.slice(at, destination.from) + next;
    at = destination.to;
  }
  return result + body.slice(at);
}

/**
 * A file's text as Linear should hold it, link by link:
 * - a link (not an image) to a synchronized document, itself included,
 *   becomes that document's URL by id in angle brackets, `<base>/<id>`, with
 *   its fragment kept (links between documents);
 * - a link or image to a file whose bytes were uploaded becomes the upload's
 *   URL; only the path changes, so a destination in angle brackets keeps them;
 * - everything else stays as written, code included.
 * Each occurrence is mapped on its own, so two links to equal bytes at
 * different paths each keep their own place.
 */
export function linearLinks(text: string, documentPath: string, targets: LinkTargets): string {
  return rewriteDestinations(text, (destination) => {
    const file = linkedFile(documentPath, destination.url);
    if (file === undefined) return undefined;
    const document = destination.image ? undefined : targets.ids?.get(file.path);
    if (document !== undefined && targets.documentUrlBase !== undefined) {
      return `<${targets.documentUrlBase}/${document.id}${file.fragment === undefined ? '' : `#${encodeFragment(file.fragment)}`}>`;
    }
    const hash = targets.hashes.get(file.path);
    const url = hash === undefined ? undefined : targets.uploadsByHash.get(hash);
    if (url === undefined) return undefined;
    return text[destination.from] === '<' ? `<${url}>` : url;
  });
}

/**
 * The way back for a comparison: document URLs of synchronized documents
 * become relative links (in angle brackets, as the engine writes a link the
 * file did not have) and upload URLs the paths of the files they hold.
 */
export function gitLinks(content: string, documentPath: string, targets: Required<Pick<LinkTargets, 'ids' | 'documentUrlBase'>> & { uploads: ReadonlyMap<string, string> }): string {
  const paths = new Map([...targets.ids].map(([path, entry]) => [entry.id, path]));
  const prefix = `${targets.documentUrlBase}/`;
  return rewriteDestinations(content, (destination) => {
    if (destination.url.startsWith(prefix)) {
      const rest = destination.url.slice(prefix.length);
      const hash = rest.indexOf('#');
      const path = paths.get(hash === -1 ? rest : rest.slice(0, hash));
      if (path === undefined) return undefined;
      const relative = posix.relative(posix.dirname(documentPath), path).split('/').map((segment) => encodeURIComponent(segment)).join('/');
      return `<${relative}${hash === -1 ? '' : rest.slice(hash)}>`;
    }
    const path = targets.uploads.get(destination.url);
    if (path === undefined) return undefined;
    const relative = posix.relative(posix.dirname(documentPath), path) || path;
    return content[destination.from] === '<' ? `<${relative}>` : relative;
  });
}

/** Whether a document holds exactly its file's text in Linear's terms (I1 for one file). */
export function sameAsFile(text: string, content: string, path: string, sides: LinkTargets): boolean {
  return linearLinks(bodyOf(text), path, sides) === content;
}

/**
 * The canaries I5 looks for: those in file content. A canary that is part of
 * a file name (`canary_in: name`) appears wherever the path is listed, in
 * summaries for example, and listing paths is allowed.
 */
export function contentCanaries<T extends { canary: string | null; canary_in?: 'content' | 'name' | null }>(files: readonly T[]): Array<T & { canary: string }> {
  return files.filter((file): file is T & { canary: string } => file.canary !== null && file.canary_in !== 'name');
}

export interface CanaryHit {
  source: string;
  canary: string;
}

/** Finds canary tokens in texts. Reports the source and the token, never the text around it. */
export function scanCanaries(texts: ReadonlyMap<string, string>, canaries: Iterable<string>): CanaryHit[] {
  const hits: CanaryHit[] = [];
  const list = [...canaries].filter((canary) => canary.length >= 6);
  for (const [source, text] of texts) for (const canary of list) if (text.includes(canary)) hits.push({ source, canary });
  return hits;
}

/** I9: requests per written document stay at or under 1.5, plus at most 5 per run. */
export function budgetHolds(requests: number, documentsWritten: number, runs: number): boolean {
  return requests <= 1.5 * documentsWritten + 5 * runs;
}

/**
 * Whether a spec assertion holds now and, when it does not, the reason;
 * `same-as` compares with the subject its `expected` names. A failed
 * comparison of two path maps names the differing paths.
 */
export async function evaluateAssertion(ctx: RunContext, assertion: Assertion): Promise<{ holds: true } | { holds: false; reason: string }> {
  const actual = await resolveSubject(ctx, assertion.subject);
  if (!actual.known) throw new HarnessGapError(`assertion subject ${assertion.subject}`);
  let expected = assertion.expected;
  if (assertion.operator === 'same-as') {
    const other = await resolveSubject(ctx, String(assertion.expected));
    if (!other.known) throw new HarnessGapError(`assertion subject ${String(assertion.expected)}`);
    expected = other.value;
  }
  if (compare(assertion.operator, actual.value, expected)) return { holds: true };
  const paths = differingPaths(actual.value, expected);
  return { holds: false, reason: `${assertion.operator} did not hold${paths === undefined ? '' : `: ${paths}`}` };
}

/**
 * The keys at which two path maps differ (on one side only, or with other
 * values), in the order `compare` sees them: the first few and how many
 * more. Keys only, never values, so a report names paths and no document
 * content (I5). Undefined unless both sides are maps that differ.
 */
export function differingPaths(actual: unknown, expected: unknown, shown = 5): string | undefined {
  if (!(actual instanceof Map) || !(expected instanceof Map)) return undefined;
  const same = (key: unknown) => actual.has(key) && expected.has(key) && JSON.stringify(normalize(actual.get(key))) === JSON.stringify(normalize(expected.get(key)));
  const differing = [...new Set([...actual.keys(), ...expected.keys()])].filter((key) => !same(key)).map(String).sort((a, b) => a.localeCompare(b));
  if (differing.length === 0) return undefined;
  const more = differing.length - shown;
  return `differs at ${differing.slice(0, shown).join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

export function compare(operator: Assertion['operator'], actual: unknown, expected: unknown): boolean {
  switch (operator) {
    case 'equal':
    case 'same-as':
      return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
    case 'contains-all':
      return Array.isArray(actual) && Array.isArray(expected) && expected.every((item) => actual.some((value) => JSON.stringify(value) === JSON.stringify(item)));
    case 'at-most':
      return typeof actual === 'number' && actual <= (expected as number);
    case 'at-least':
      return typeof actual === 'number' && actual >= (expected as number);
  }
}

function normalize(value: unknown): unknown {
  if (value instanceof Set) return [...value].sort();
  if (value instanceof Map) return Object.fromEntries([...value].sort(([a], [b]) => String(a).localeCompare(String(b))));
  return value;
}

// --- the run's two sides -----------------------------------------------------

export interface Sides {
  /** Synchronized Markdown files of the tracked branch's tip: path → text. */
  files: Map<string, string>;
  ids: IdMap;
  /** Upload URL → file path in the tree. */
  uploads: Map<string, string>;
  /** Documents by id: every listed one, and every mapped id's document that Linear still has, trashed and archived ones included. */
  documents: Map<string, LinearDocument>;
  /** Every document in the run's projects and team-zone prefix. */
  allDocuments: LinearDocument[];
  /** SHA-256 of a file → upload URL, as the uploads ref holds it. */
  uploadsByHash: Map<string, string>;
  /** Every tracked file's SHA-256 (an LFS pointer's object id for LFS files) by path. */
  hashes: Map<string, string>;
  /** The tracked branch's tip. */
  tip: string;
  /** Annotated folders of the tracked branch. */
  folders: Folder[];
  /** The URL prefix of the workspace's documents, for links between synchronized documents. */
  documentUrlBase: string;
  /**
   * Synchronized files the scenario's own runs left out on purpose, with the
   * rule their reports gave: path → `lint: <rules>` or `write: <rule>`.
   */
  omitted: Map<string, string>;
}

/** Rules of files left out because of files they link; such an entry names those files. */
const RULES_WITH_FILES = new Set([UPLOAD_TOO_LARGE, UPLOAD_UNREADABLE]);

/** Report lists of paths a run wrote, tried to write or held back: any of them ends a write-time omission. */
const DECIDED_PATHS = ['created', 'overwritten', 'unchanged', 'updated', 'adopted', 'restored', 'notAttempted'];
/** Report lists of entries with a path that do the same: failed and skipped writes. */
const DECIDED_ENTRIES = ['failed', 'skipped'];

/**
 * The files the runs left out on purpose, from their own reports, in run
 * order: the latest decision about a path wins. A run that wrote a path, or
 * tried to (created, overwrote, updated, relocated, adopted, restored, found
 * it unchanged, failed, skipped or did not reach it), takes it back in. A
 * run that lists every left-out file of its tree (a sync's `sync.leftOut`, a
 * confirmed initial sync's plan) replaces the lint-time omissions; a
 * write-time omission (`leftOutAtWrite`) stays until a run decides
 * otherwise about the path. An entry counts only with its rule and, for a
 * rule found from linked files, those files: anything else is unexplained.
 */
export function deliberateOmissions(results: readonly Pick<EngineResult, 'report'>[]): Map<string, string> {
  const lint = new Map<string, string>();
  const write = new Map<string, string>();
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null);
  /** An entry's rules, or none when a rule found from linked files does not name them. */
  const explained = (entry: Record<string, unknown> | null, rules: unknown[]): string[] => {
    const named = rules.filter((rule): rule is string => typeof rule === 'string' && rule !== '');
    return named.some((rule) => RULES_WITH_FILES.has(rule)) && list(entry?.['files']).length === 0 ? [] : named;
  };
  for (const { report } of results) {
    const initial = record(report?.['initialSync']);
    const sync = record(report?.['sync']);
    if (initial === null && sync === null) continue;
    const full = sync !== null ? list(sync['leftOut']) : list(record(report?.['summary'])?.['leftOutFiles']);
    lint.clear();
    for (const entry of full.map(record)) {
      const rules = explained(entry, list(entry?.['rules']));
      if (typeof entry?.['path'] === 'string' && rules.length > 0) lint.set(entry['path'], `lint: ${rules.join(', ')}`);
    }
    for (const side of [initial, sync]) {
      if (side === null) continue;
      const decided = [
        ...DECIDED_PATHS.flatMap((key) => list(side[key])),
        ...DECIDED_ENTRIES.flatMap((key) => list(side[key]).map((entry) => record(entry)?.['path'])),
        ...list(side['relocated']).map((entry) => record(entry)?.['to']),
      ];
      for (const path of decided) if (typeof path === 'string') write.delete(path);
      for (const entry of list(side['leftOutAtWrite']).map(record)) {
        const path = entry?.['path'];
        const rules = explained(entry, [entry?.['rule']]);
        if (typeof path === 'string' && rules.length > 0) write.set(path, `write: ${rules.join(', ')}`);
      }
    }
  }
  return new Map([...lint, ...write]);
}

/** A file's SHA-256: an LFS pointer's object id, else the hash of the bytes. */
export function fileHash(bytes: Buffer): string {
  const pointer = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\n/.exec(bytes.toString('latin1'));
  return pointer?.[1] ?? createHash('sha256').update(bytes).digest('hex');
}

/** An LFS pointer's object size, or null for a file stored in git. */
export function lfsSize(bytes: Buffer): number | null {
  const match = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n[\s\S]*?^size (\d+)$/m.exec(bytes.toString('latin1'));
  return match === null ? null : Number(match[1]);
}

export async function fetchRef(git: Git, ref: string): Promise<string | null> {
  try {
    await git.run(['fetch', '--quiet', 'origin', `+${ref}:${ref}`]);
    return (await git.text(['rev-parse', ref])).trim();
  } catch {
    return null;
  }
}

/** Single-document reads `readSides` sends at once. */
const SINGLE_READS_AT_ONCE = 5;

/** Reads both sides; without `allowNoIds`, a run with no ids state ref is a product error. */
export async function readSides(ctx: RunContext, options: { allowNoIds?: boolean } = {}): Promise<Sides> {
  const world = ctx.live;
  if (world === null) throw new Error('offline scenarios have no sides');
  const git = await ctx.person();
  await git.run(['pull', '--quiet', '--no-rebase', '--no-edit', 'origin', ctx.names.trackedBranch]);
  const config = resolveStateConfig({ trackedBranch: ctx.names.trackedBranch, syncBranch: ctx.names.syncBranch, refPrefix: ctx.names.refPrefix });
  const idsCommit = await fetchRef(git, stateRef(config, 'ids'));
  const uploadsCommit = await fetchRef(git, stateRef(config, 'uploads'));
  // No ids ref: the engine recorded nothing (a refusal, a check, a dry run). The mapping is empty, not an error.
  void options;
  const ids: IdMap = idsCommit === null ? new Map() : await readIds(git, idsCommit);
  const uploadsByHash = await readUploads(git, uploadsCommit);

  const tracked = (await git.text(['ls-files', '-z'])).split('\0').filter(Boolean);
  const readmes = new Map<string, string>();
  for (const path of tracked) if (/(^|\/)README\.md$/.test(path)) readmes.set(path, readFileSync(join(git.dir, path), 'utf8'));
  const folders = annotatedFolders(readmes);
  // Files of the slice that the corpus marks as not synchronized or left out (lint errors) have no document.
  const manifest = new Map(world.manifest.files.map((file) => [file.path, file]));
  const unsynced = new Set<string>();
  for (const [target, source] of world.tree.paths) {
    const entry = manifest.get(source);
    if (entry !== undefined && (!entry.synced || entry.class === 'lint-error')) unsynced.add(target);
  }
  const files = new Map<string, string>();
  const hashToPath = new Map<string, string>();
  const hashes = new Map<string, string>();
  for (const path of tracked) {
    const bytes = readFileSync(join(git.dir, path));
    const hash = fileHash(bytes);
    hashToPath.set(hash, path);
    hashes.set(path, hash);
    if (path.endsWith('.md') && owningFolder(path, folders) !== null && !unsynced.has(path)) files.set(path, bytes.toString('utf8'));
  }
  const uploads = new Map<string, string>();
  for (const [hash, url] of uploadsByHash) {
    const path = hashToPath.get(hash);
    if (path !== undefined) uploads.set(url, path);
  }

  const allDocuments: LinearDocument[] = [];
  for (const project of world.projects.values()) allDocuments.push(...(await world.app.listDocuments({ projectId: project.id }, { withContent: true })));
  for (const team of world.tree.teamZones.keys()) {
    const teamId = world.teams.get(team)?.id;
    if (teamId === undefined) continue;
    const documents = await world.app.listDocuments({ teamId }, { withContent: true });
    allDocuments.push(...documents.filter((document) => document.projectId === null && document.title.startsWith(ctx.names.teamZonePrefix)));
  }
  const documents = new Map(allDocuments.map((document) => [document.id, document]));
  const missing = [...ids.values()].map((entry) => entry.id).filter((id) => !documents.has(id));
  if (missing.length > 0) for (const document of await world.app.getDocuments(missing, { withContent: true })) documents.set(document.id, document);
  // An id that no list and no batch read returned is read on its own, so the checks tell a trashed or
  // archived document from one Linear no longer has. Measured, the batch read returns trashed and
  // archived documents, so this stays rare; the reads run a few at a time.
  const unresolved = missing.filter((id) => !documents.has(id));
  for (let start = 0; start < unresolved.length; start += SINGLE_READS_AT_ONCE) {
    const read = await Promise.all(unresolved.slice(start, start + SINGLE_READS_AT_ONCE).map((id) => world.app.getDocument(id)));
    for (const document of read) if (document !== null) documents.set(document.id, document);
  }
  const tip = (await git.text(['rev-parse', 'HEAD'])).trim();
  const omitted = deliberateOmissions(ctx.engine.results);
  return { files, ids, uploads, documents, allDocuments, uploadsByHash, hashes, tip, folders, documentUrlBase: world.documentUrlBase, omitted };
}

// --- invariants ---------------------------------------------------------------

type Check = (ctx: RunContext, sides: () => Promise<Sides>) => Promise<CheckOutcome>;

const ok = (name: string): CheckOutcome => ({ name, ok: true });
const bad = (name: string, detail: string): CheckOutcome => ({ name, ok: false, detail });

export const INVARIANT_CHECKS: Record<InvariantId, Check> = {
  async I1(_ctx, sides) {
    const s = await sides();
    const differing: string[] = [];
    for (const [path, text] of s.files) {
      // A file its run left out on purpose has no document to match; its earlier document, if any, stays as it was.
      if (s.omitted.has(path)) continue;
      const entry = s.ids.get(path);
      const document = entry === undefined ? undefined : s.documents.get(entry.id);
      if (document === undefined || document.trashed) {
        differing.push(`${path} (no document)`);
        continue;
      }
      if (!sameAsFile(text, document.content ?? '', path, s)) differing.push(path);
    }
    return differing.length === 0 ? ok('I1') : bad('I1', `${differing.length} files differ from their documents: ${differing.slice(0, 10).join(', ')}`);
  },

  async I2(ctx, sides) {
    if (ctx.edits.length === 0) return ok('I2');
    const lost = lostEdits(ctx, await sides());
    return lost.length === 0 ? ok('I2') : bad('I2', `${lost.length} edits are not on both sides: ${lost.map((edit) => `${edit.side} ${edit.token}`).join(', ')}`);
  },

  async I3(ctx) {
    const git = await ctx.person();
    await git.run(['fetch', '--quiet', 'origin', ctx.names.trackedBranch]);
    // First parents only: commits that reached the branch through a sync merge are the merge's, not the branch's own.
    const lines = (await git.text(['rev-list', '--first-parent', '--parents', 'FETCH_HEAD'])).split('\n').filter(Boolean);
    const own = new Set(ctx.ownCommits);
    const foreign = lines
      .map((line) => line.split(' '))
      .filter(([commit, ...parents]) => parents.length > 0 && !own.has(commit as string) && parents.length < 2)
      .map(([commit]) => (commit as string).slice(0, 12));
    return foreign.length === 0 ? ok('I3') : bad('I3', `commits on the tracked branch that are neither the scenario's nor sync merges: ${foreign.join(', ')}`);
  },

  async I4(ctx) {
    const history = (ctx.observations.get('refHistory') as Array<Record<string, string>> | undefined) ?? [];
    const git = await ctx.person();
    const backwards: string[] = [];
    for (let index = 1; index < history.length; index += 1) {
      const before = history[index - 1] as Record<string, string>;
      const after = history[index] as Record<string, string>;
      for (const [ref, old] of Object.entries(before)) {
        const next = after[ref];
        if (next === undefined || next === old) continue;
        await git.run(['fetch', '--quiet', 'origin', old, next], { okCodes: [0, 1, 128] });
        const result = await git.run(['merge-base', '--is-ancestor', old, next], { okCodes: [0, 1, 128] });
        if (result.code !== 0) backwards.push(ref.replace(`${ctx.names.refPrefix}/`, '').replace(`refs/heads/${ctx.names.syncBranch}`, 'sync branch'));
      }
    }
    return backwards.length === 0 ? ok('I4') : bad('I4', `refs moved other than forward: ${[...new Set(backwards)].join(', ')}`);
  },

  async I5(ctx) {
    const hits = await canaryScan(ctx, { summariesOnly: false });
    return hits.length === 0 ? ok('I5') : bad('I5', `canary tokens found in: ${[...new Set(hits.map((hit) => hit.source))].join(', ')}`);
  },

  async I6(ctx) {
    const before = (ctx.observations.get('refHistory') as Array<Record<string, string>> | undefined)?.at(-1) ?? {};
    const world = ctx.live;
    const trackedBefore = world === null ? undefined : await trackedTip(ctx);
    const pullRequestsBefore = world === null ? 0 : (await world.rest.pullRequests(`t/${ctx.names.runId}/`)).length;
    const proxy = ctx.proxy;
    const mutationsBefore = proxy?.counts().mutations ?? 0;
    const runsBefore = ctx.engine.results.length;
    const { STEP_ACTIONS } = await import('./steps.ts');
    await (STEP_ACTIONS['run.sync'] as (c: RunContext, a: Record<string, unknown>) => Promise<void>)(ctx, {});
    const run = ctx.engine.results.length === runsBefore + 1 ? ctx.engine.results.at(-1) : undefined;
    if (run === undefined) return bad('I6', `idempotence was not established: expected one result for the no-change sync run, recorded ${ctx.engine.results.length - runsBefore}`);
    if (run.exitCode !== 0 || run.signal !== null) {
      return bad('I6', `idempotence was not established: the no-change sync run did not succeed (exit ${String(run.exitCode)}, signal ${String(run.signal)})`);
    }
    const report = run.report;
    const capture = report?.['capture'] as Record<string, unknown> | null | undefined;
    if (report?.['operation'] !== 'sync' || report['ok'] !== true || report['complete'] !== true || capture?.['ok'] !== true) {
      return bad('I6', `idempotence was not established: the no-change sync run lacks a successful completed report (operation ${String(report?.['operation'])}, ok ${String(report?.['ok'])}, complete ${String(report?.['complete'])}, capture.ok ${String(capture?.['ok'])}, code ${String(report?.['code'])})`);
    }
    const after = await snapshotRefs(ctx);
    const moved = Object.keys({ ...before, ...after }).filter((ref) => before[ref] !== after[ref]);
    const writes = (proxy?.counts().mutations ?? 0) - mutationsBefore;
    const trackedMoved = world !== null && (await trackedTip(ctx)) !== trackedBefore;
    const newPullRequests = world === null ? 0 : (await world.rest.pullRequests(`t/${ctx.names.runId}/`)).length - pullRequestsBefore;
    if (moved.length > 0 || writes > 0 || trackedMoved || newPullRequests > 0) {
      return bad('I6', `one more run with no changes wrote ${writes} mutations, moved ${moved.length} refs${trackedMoved ? ', moved the tracked branch' : ''} and opened ${newPullRequests} pull requests`);
    }
    return ok('I6');
  },

  async I7(ctx, sides) {
    const s = await sides();
    const readmes = new Map<string, string>();
    for (const path of s.files.keys()) if (/(^|\/)README\.md$/.test(path)) readmes.set(path, s.files.get(path) as string);
    const folders = annotatedFolders(readmes);
    const problems: string[] = [];
    for (const path of s.files.keys()) {
      const entry = s.ids.get(path);
      if (entry === undefined) {
        // Left out on purpose, it needs no id; a mapped one is still checked below.
        if (!s.omitted.has(path)) problems.push(`${path} has no id`);
        continue;
      }
      const document = s.documents.get(entry.id);
      const folder = owningFolder(path, folders);
      const state = documentState(document);
      if (state !== 'active') problems.push(`${path}: its document is ${state === 'missing' ? 'not in Linear' : state === 'trashed' ? "in Linear's trash" : 'archived'}`);
      else if (folder !== null && !pathFitsTitle(titleOf(path, folder.folder), (document as LinearDocument).title, entry.id)) problems.push(`${path}: title differs from its path`);
      else if (folder !== null) {
        // Live only: offline there is no world to name the document's place.
        const place = placeOf(ctx, document);
        const expected = expectedPlace(folders, path)?.place;
        if (place !== null && place !== expected) problems.push(`${path}: its document is in ${place}, not in its folder's ${expected}`);
      }
    }
    for (const path of s.ids.keys()) if (!s.files.has(path)) problems.push(`${path} is mapped but not a synchronized file`);
    return problems.length === 0 ? ok('I7') : bad('I7', `${problems.length} problems: ${problems.slice(0, 10).join('; ')}`);
  },

  async I8(_ctx, sides) {
    const s = await sides();
    const seen = new Map<string, number>();
    for (const document of s.allDocuments) {
      if (document.trashed || document.archivedAt !== null) continue;
      const key = `${document.projectId ?? document.teamId}:${document.title}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const duplicates = [...seen].filter(([, count]) => count > 1).map(([key]) => key.split(':').slice(1).join(':'));
    return duplicates.length === 0 ? ok('I8') : bad('I8', `duplicate titles: ${duplicates.slice(0, 10).join(', ')}`);
  },

  async I9(ctx) {
    const proxy = ctx.proxy;
    if (proxy === null) return ok('I9');
    const requests = proxy.requests.filter((record) => !record.injected).length;
    const written = proxy.requests.filter((record) => record.kind === 'mutation' && /document(Create|Update)|(Create|Update)Document/i.test(record.operation) && record.status === 200).length;
    const runs = ctx.engine.results.length;
    return budgetHolds(requests, written, runs)
      ? ok('I9')
      : bad('I9', `${requests} requests for ${written} written documents in ${runs} runs (limit ${1.5 * written + 5 * runs})`);
  },
};

/** Edits that are not on both sides (or, for a removal, still on a side). */
export function lostEdits(ctx: RunContext, sides: Pick<Sides, 'files' | 'documents'>): RunContext['edits'] {
  const gitText = [...sides.files.values()].join('\n');
  const linearText = [...sides.documents.values()].filter((document) => !document.trashed).map((document) => document.content ?? '').join('\n');
  return ctx.edits.filter((edit) => {
    if (edit.retired === true) return false;
    const inGit = gitText.includes(edit.token);
    const inLinear = linearText.includes(edit.token);
    return edit.removal === true ? inGit || inLinear : !(inGit && inLinear);
  });
}

/** Canary tokens of the run's slice in run logs and summaries and, unless `summariesOnly`, in pull request texts and Linear comments. */
export async function collectCanaryEvidence(ctx: RunContext, options: { summariesOnly: boolean }) {
  const world = ctx.live;
  const canaries = new Set<string>();
  if (world !== null) {
    const sources = new Set(world.tree.paths.values());
    // Content canaries only: a canary in a file name (canary_in: name) shows wherever paths are listed, which is allowed.
    for (const file of contentCanaries(world.manifest.files)) if (sources.has(file.path)) canaries.add(file.canary);
  }
  const texts = new Map<string, string>();
  const cleanupLog = ctx.observations.get('cleanup.output');
  if (!options.summariesOnly && typeof cleanupLog === 'string') texts.set('cleanup stdout/stderr', cleanupLog);
  ctx.engine.results.forEach((result, index) => {
    texts.set(`run ${index} summary`, result.summary);
    if (options.summariesOnly) return;
    texts.set(`run ${index} stdout`, result.stdout);
    texts.set(`run ${index} stderr`, result.stderr);
  });
  const cached = ctx.observations.get('canary.remoteTexts') as Record<string, string> | undefined;
  if (!options.summariesOnly && cached !== undefined) {
    for (const [source, text] of Object.entries(cached)) texts.set(source, text);
  } else if (world !== null && !options.summariesOnly) {
    for (const pr of await world.rest.pullRequests(`t/${ctx.names.runId}/`)) texts.set(`pull request #${pr.number}`, `${pr.title}\n${pr.body ?? ''}`);
    // Linear comments on the run's documents: project documents, and team-zone documents with the run's prefix.
    for (const project of world.projects.values()) {
      for (const document of await commentsOf(world.app, { project: { id: { eq: project.id } } })) {
        texts.set(`comments on ${document.id}`, document.bodies.join('\n'));
      }
    }
    for (const team of world.tree.teamZones.keys()) {
      const teamId = world.teams.get(team)?.id;
      if (teamId === undefined) continue;
      for (const document of await commentsOf(world.app, { team: { id: { eq: teamId } }, title: { startsWith: ctx.names.teamZonePrefix } })) {
        if (!document.inProject) texts.set(`comments on ${document.id}`, document.bodies.join('\n'));
      }
    }
  }
  if (!options.summariesOnly && cached === undefined && world !== null) {
    ctx.observations.set('canary.remoteTexts', Object.fromEntries([...texts].filter(([source]) => source.startsWith('pull request #') || source.startsWith('comments on '))));
  }
  return { canaries: [...canaries], texts: Object.fromEntries(texts) };
}

export async function canaryScan(ctx: RunContext, options: { summariesOnly: boolean }): Promise<CanaryHit[]> {
  const evidence = await collectCanaryEvidence(ctx, options);
  return scanCanaries(new Map(Object.entries(evidence.texts)), evidence.canaries);
}

async function trackedTip(ctx: RunContext): Promise<string | undefined> {
  const world = ctx.live;
  if (world === null) return undefined;
  return (await world.sandbox.runRefs()).find((ref) => ref.ref === `refs/heads/${ctx.names.trackedBranch}`)?.oid;
}

/**
 * Small pages keep a query under Linear's complexity limit: documents times
 * comments per document is what a query costs (250 × 50 was refused).
 */
export const COMMENT_DOCUMENTS_PER_PAGE = 25;
export const COMMENTS_PER_DOCUMENT = 50;

/** The comment bodies of every document that matches `filter`, page by page. */
export async function commentsOf(
  client: Pick<LinearClient, 'request'>,
  filter: Record<string, unknown>,
): Promise<Array<{ id: string; inProject: boolean; bodies: string[] }>> {
  const result: Array<{ id: string; inProject: boolean; bodies: string[] }> = [];
  let after: string | null = null;
  for (;;) {
    const data: {
      documents: {
        nodes: Array<{ id: string; project: { id: string } | null; comments: { nodes: Array<{ body: string }>; pageInfo?: { hasNextPage: boolean; endCursor: string | null } } }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await client.request(
      'RunComments',
      'query',
      `query RunComments($filter: DocumentFilter, $after: String) {
        documents(first: ${COMMENT_DOCUMENTS_PER_PAGE}, after: $after, filter: $filter) {
          nodes { id project { id } comments(first: ${COMMENTS_PER_DOCUMENT}) { nodes { body } pageInfo { hasNextPage endCursor } } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { filter, after },
    );
    for (const document of data.documents.nodes) {
      const bodies = document.comments.nodes.map((comment) => comment.body);
      let page = document.comments.pageInfo;
      while (page?.hasNextPage) {
        if (!page.endCursor) throw new Error('comment pagination has no cursor');
        const more = await client.request<{
          document: { comments: { nodes: Array<{ body: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
        }>('RunCommentPage', 'query', `query RunCommentPage($id: String!, $after: String!) {
          document(id: $id) { comments(first: ${COMMENTS_PER_DOCUMENT}, after: $after) {
            nodes { body } pageInfo { hasNextPage endCursor }
          } }
        }`, { id: document.id, after: page.endCursor });
        bodies.push(...more.document.comments.nodes.map((comment) => comment.body));
        page = more.document.comments.pageInfo;
      }
      result.push({ id: document.id, inProject: document.project !== null, bodies });
    }
    if (!data.documents.pageInfo.hasNextPage) return result;
    after = data.documents.pageInfo.endCursor;
  }
}

/** The run's branches and state refs on the sandbox: ref → commit. */
export async function snapshotRefs(ctx: RunContext): Promise<Record<string, string>> {
  const world = ctx.live;
  if (world === null) return {};
  const refs = await world.sandbox.runRefs();
  return Object.fromEntries(refs.filter((ref) => ref.runId === ctx.names.runId && ref.ref !== `refs/heads/${ctx.names.trackedBranch}`).map((ref) => [ref.ref, ref.oid]));
}

// --- assertions --------------------------------------------------------------

// Assertion subjects resolve in subjects.ts: observed, from the engine's report, or computed by the harness.
export { resolveSubject };

export async function runChecks(ctx: RunContext): Promise<CheckOutcome[]> {
  // The scenario's own runs and requests end here; I6's extra run is the check's, not the scenario's.
  ctx.observations.set('scenario.runsEnd', ctx.engine.results.length);
  ctx.observations.set('scenario.proxyEnd', ctx.proxy?.requests.length ?? 0);
  let cached: Promise<Sides> | undefined;
  const sides = () => (cached ??= readSides(ctx));
  const outcomes: CheckOutcome[] = [];
  // A check the product cannot satisfy yet (a "not implemented" command in I6, a value the report lacks) fails
  // on its own; every other check is still evaluated, so one missing command hides no other result.
  const productFailure = (error: unknown) => error instanceof ProductError || error instanceof NotImplementedError;
  // I5 sees I6's extra engine run too; its remote output can then be reused at cleanup.
  for (const id of [...INVARIANTS.filter((id) => id !== 'I5'), 'I5' as const]) {
    if (!ctx.scenario.checks.invariants[id].required) continue;
    try {
      outcomes.push(await INVARIANT_CHECKS[id](ctx, sides));
    } catch (error) {
      if (productFailure(error)) outcomes.push(bad(id, (error as Error).message));
      else throw error;
    }
  }
  // I6 ran the sync once more: assertions read the world as it is now.
  refreshView(ctx);
  for (const assertion of ctx.scenario.checks.assertions) {
    try {
      const result = await evaluateAssertion(ctx, assertion);
      outcomes.push(result.holds ? ok(assertion.subject) : bad(assertion.subject, result.reason));
    } catch (error) {
      if (productFailure(error)) outcomes.push(bad(assertion.subject, (error as Error).message));
      else throw error;
    }
  }
  return outcomes;
}

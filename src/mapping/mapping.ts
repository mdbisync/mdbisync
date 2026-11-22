// Maps the files of a commit to Linear documents: annotated
// folders give the team and project, deeper folders become a path prefix of
// the title. Only `.md` files are synchronized; files above every annotation
// are not.

import { type Git, type Oid } from '../state/git.ts';
import { parseLfsPointer } from '../state/lfs.ts';
import { type TreeEntry, listTree } from '../state/objects.ts';
import { MAPPING_FILE_BYTES, MAPPING_TREE_BYTES, MappingBlobBudget, readableBlob } from './blobs.ts';
import {
  ANNOTATION_FILE,
  type Annotation,
  type AnnotationProblem,
  type Zone,
  folderOf,
  nearestZone,
  readAnnotation,
  resolveZones,
} from './annotations.ts';
import { message } from '../messages.ts';
import { type LeftOutRule, type UnsyncedReason } from '../codes.ts';

export const MARKDOWN_EXTENSION = '.md';

/** Where a document lives: a project of a team, or the team itself (a team zone). */
export type Place = { kind: 'project'; team: string; project: string } | { kind: 'team'; team: string };

export interface MappedDocument {
  path: string;
  oid: Oid;
  /** The Linear title: the path below the project folder (or the team folder in a team zone), without `.md`. */
  title: string;
  place: Place;
}

export type { UnsyncedReason } from '../codes.ts';

/** A `.md` file that is not synchronized, and why. */
export interface UnsyncedFile {
  path: string;
  reason: UnsyncedReason;
  /** Where the file would be synchronized, for a file under an annotation. */
  title?: string;
  place?: Place;
}

/**
 * A file the sync would map but leaves out. Two files whose titles are
 * equal once Unicode-normalized (NFC) and lower-cased, in the same place,
 * collide: neither is synchronized, and both are listed.
 */
export interface LeftOutFile {
  path: string;
  oid: Oid;
  rule: Extract<LeftOutRule, 'duplicate-title'>;
  title: string;
  place: Place;
  /** Other files with the same title in the same place: at most `COLLISIONS_NAMED` of them. */
  collidesWith: string[];
  /** How many more files have that title, beyond those `collidesWith` names. */
  collidesWithMore?: number;
}

export interface RepositoryMapping {
  annotations: Annotation[];
  /** The effective team and project of each usable annotated folder. */
  zones: Map<string, Zone>;
  /** Annotations the run cannot use; the setup check fails on any. */
  problems: AnnotationProblem[];
  documents: MappedDocument[];
  unsynced: UnsyncedFile[];
  leftOut: LeftOutFile[];
  /**
   * Every regular file of the tree, by path: what a document's image may
   * name. Symbolic links and submodules are not files here.
   */
  files: ReadonlySet<string>;
}

/** Files that hold annotations: every `README.md`. */
export function annotationFiles(entries: readonly TreeEntry[]): TreeEntry[] {
  return entries.filter((entry) => entry.type === 'blob' && baseName(entry.path) === ANNOTATION_FILE);
}

/** Reads the annotations of the given `README.md` files. */
export function collectAnnotations(readmes: ReadonlyMap<string, string>): { annotations: Annotation[]; problems: AnnotationProblem[] } {
  const annotations: Annotation[] = [];
  const problems: AnnotationProblem[] = [];
  for (const [path, text] of readmes) {
    const result = readAnnotation(path, text);
    if ('problem' in result) problems.push(result.problem);
    else if (result.annotation !== null) annotations.push(result.annotation);
  }
  return { annotations, problems };
}

/** `.md` files under an annotated folder: the ones whose content the mapping must see. */
export function candidateFiles(entries: readonly TreeEntry[], zones: ReadonlyMap<string, Zone>): TreeEntry[] {
  return entries.filter((entry) => isMarkdown(entry) && isRegularFile(entry) && nearestZone(zones, folderOf(entry.path)) !== undefined);
}

/**
 * Maps every file. `contents` holds the blobs of the candidate files (see
 * `candidateFiles`). A candidate within the byte limit whose blob is missing is an error.
 */
export function mapFiles(
  entries: readonly TreeEntry[],
  zones: ReadonlyMap<string, Zone>,
  contents: ReadonlyMap<Oid, Buffer>,
): Pick<RepositoryMapping, 'documents' | 'unsynced' | 'leftOut' | 'files'> {
  const mapped: MappedDocument[] = [];
  const unsynced: UnsyncedFile[] = [];
  for (const entry of entries) {
    if (!isMarkdown(entry)) continue;
    const zone = nearestZone(zones, folderOf(entry.path));
    if (zone === undefined) {
      unsynced.push({ path: entry.path, reason: 'outside-annotations' });
      continue;
    }
    if (!isRegularFile(entry)) {
      unsynced.push({ path: entry.path, reason: 'not-a-regular-file', title: titleOf(entry.path, zone), place: placeOf(zone) });
      continue;
    }
    if (!readableBlob(entry)) {
      unsynced.push({ path: entry.path, reason: 'blob-too-large', title: titleOf(entry.path, zone), place: placeOf(zone) });
      continue;
    }
    const content = contents.get(entry.oid);
    if (content === undefined) throw new Error(message('mapping.content-not-read', { path: entry.path }));
    const problem = contentProblem(content);
    if (problem !== null) {
      unsynced.push({ path: entry.path, reason: problem, title: titleOf(entry.path, zone), place: placeOf(zone) });
      continue;
    }
    mapped.push({ path: entry.path, oid: entry.oid, title: titleOf(entry.path, zone), place: placeOf(zone) });
  }
  const { documents, leftOut } = separateCollisions(mapped);
  const files = new Set(entries.filter(isRegularFile).map((entry) => entry.path));
  return { documents, unsynced, leftOut, files };
}

/** Maps the files of a commit, reading only `README.md` files and the `.md` files under annotations. */
export async function loadMapping(git: Git, commit: Oid): Promise<RepositoryMapping> {
  return mapTree(git, await listTree(git, commit, MAPPING_TREE_BYTES), new MappingBlobBudget());
}

export async function mapTree(git: Git, entries: readonly TreeEntry[], budget: MappingBlobBudget): Promise<RepositoryMapping> {
  const annotations = await readTreeAnnotations(git, entries, budget);
  const contents = await budget.read(git, candidateFiles(entries, annotations.zones));
  return { ...annotations, ...mapFiles(entries, annotations.zones, contents) };
}

/** Check a proposed state tree's budget without loading candidate document bodies. */
export async function checkMappingBudget(git: Git, commit: Oid, knownPaths: ReadonlyMap<string, unknown>): Promise<void> {
  const entries = await listTree(git, commit, MAPPING_TREE_BYTES);
  requireReadableAnnotations(entries);
  const budget = new MappingBlobBudget();
  const { zones } = await readTreeAnnotations(git, entries, budget);
  budget.check(candidateFiles(entries, zones));
  budget.check(entries.filter((entry) => entry.type === 'blob' && knownPaths.has(entry.path)));
}

/** A folder annotation over the mapping's size limit, which `requireReadableAnnotations` refuses. */
export class UnreadableAnnotationError extends Error {}

/** A merge must not mistake an unreadable folder annotation for a removed one. */
export function requireReadableAnnotations(entries: readonly TreeEntry[]): void {
  const entry = annotationFiles(entries).find((entry) => !readableBlob(entry));
  if (entry !== undefined) throw new UnreadableAnnotationError(oversizedAnnotation(entry.path).message);
}

function oversizedAnnotation(readme: string): AnnotationProblem {
  return { readme, kind: 'invalid-annotation', message: message('annotations.blob-too-large', { readme, bytes: MAPPING_FILE_BYTES }) };
}

async function readTreeAnnotations(git: Git, entries: readonly TreeEntry[], budget: MappingBlobBudget): Promise<Pick<RepositoryMapping, 'annotations' | 'zones' | 'problems'>> {
  const readmeEntries = annotationFiles(entries);
  const readmeBlobs = await budget.read(git, readmeEntries);
  const unreadableAnnotations: AnnotationProblem[] = [];
  const readmes = new Map<string, string>();
  for (const entry of readmeEntries) {
    if (readableBlob(entry)) {
      readmes.set(entry.path, readmeBlobs.get(entry.oid)!.toString('utf8'));
    } else {
      unreadableAnnotations.push(oversizedAnnotation(entry.path));
    }
  }
  const { annotations, problems: readProblems } = collectAnnotations(readmes);
  const { zones, problems: zoneProblems } = resolveZones(annotations);
  return { annotations, zones, problems: [...unreadableAnnotations, ...readProblems, ...zoneProblems] };
}

/** The key under which two titles in one place are the same document title. */
export function titleKey(place: Place, title: string): string {
  const where = place.kind === 'project' ? `project\0${place.team}\0${place.project}` : `team\0${place.team}`;
  return `${where}\0${title.normalize('NFC').toLowerCase()}`;
}

/** The most other paths a left-out file's `collidesWith` names; `collidesWithMore` counts the rest. */
const COLLISIONS_NAMED = 3;

function separateCollisions(mapped: readonly MappedDocument[]): { documents: MappedDocument[]; leftOut: LeftOutFile[] } {
  const groups = new Map<string, MappedDocument[]>();
  for (const document of mapped) {
    const key = titleKey(document.place, document.title);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [document]);
    else group.push(document);
  }
  const documents: MappedDocument[] = [];
  const leftOut: LeftOutFile[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      documents.push(group[0] as MappedDocument);
      continue;
    }
    // Each file names the first few others of its group and counts the rest, so a group of n files
    // reports a number of paths linear in n, not n squared.
    const named = group.slice(0, COLLISIONS_NAMED + 1);
    group.forEach((document, index) => {
      const collidesWith = named.filter((_, other) => other !== index).slice(0, COLLISIONS_NAMED).map((other) => other.path);
      const more = group.length - 1 - collidesWith.length;
      leftOut.push({
        path: document.path,
        oid: document.oid,
        rule: 'duplicate-title',
        title: document.title,
        place: document.place,
        collidesWith,
        ...(more > 0 ? { collidesWithMore: more } : {}),
      });
    });
  }
  return { documents, leftOut };
}

function titleOf(path: string, zone: Zone): string {
  const base = zone.projectFolder ?? zone.teamFolder;
  const relative = base === '' ? path : path.slice(base.length + 1);
  return relative.slice(0, -MARKDOWN_EXTENSION.length);
}

/** The Linear place a zone's files go to. */
export function placeOf(zone: Zone): Place {
  return zone.project !== undefined ? { kind: 'project', team: zone.team, project: zone.project } : { kind: 'team', team: zone.team };
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

function contentProblem(content: Buffer): 'binary' | 'stored-in-lfs' | null {
  if (parseLfsPointer(content) !== null) return 'stored-in-lfs';
  if (content.includes(0)) return 'binary';
  try {
    UTF8.decode(content);
  } catch {
    return 'binary';
  }
  return null;
}

function isMarkdown(entry: TreeEntry): boolean {
  return isMarkdownPath(entry.path);
}

/** A path the sync may hold a document at: a named `.md` file. */
export function isMarkdownPath(path: string): boolean {
  return path.endsWith(MARKDOWN_EXTENSION) && path.length > MARKDOWN_EXTENSION.length && !path.endsWith(`/${MARKDOWN_EXTENSION}`);
}

/** A file whose bytes git stores as they are: not a symlink or a submodule. */
export function isRegularFile(entry: TreeEntry): boolean {
  return entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755');
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

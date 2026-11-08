// Maps the files of a commit to Linear documents: annotated
// folders give the team and project, deeper folders become a path prefix of
// the title. Only `.md` files are synchronized; files above every annotation
// are not.

import { type Git, type Oid } from '../state/git.ts';
import { parseLfsPointer } from '../state/lfs.ts';
import { type TreeEntry, listTree, readBlobs } from '../state/objects.ts';
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

export type UnsyncedReason = 'outside-annotations' | 'not-a-regular-file' | 'binary' | 'stored-in-lfs';

/** A `.md` file that is not synchronized, and why. */
export interface UnsyncedFile {
  path: string;
  reason: UnsyncedReason;
}

/**
 * A file the sync would map but leaves out. Two files whose titles are
 * equal once Unicode-normalized (NFC) and lower-cased, in the same place,
 * collide: neither is synchronized, and both are listed.
 */
export interface LeftOutFile {
  path: string;
  rule: 'duplicate-title';
  title: string;
  place: Place;
  collidesWith: string[];
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
 * `candidateFiles`); a candidate whose blob is missing is an error.
 */
export function mapFiles(
  entries: readonly TreeEntry[],
  zones: ReadonlyMap<string, Zone>,
  contents: ReadonlyMap<Oid, Buffer>,
): Pick<RepositoryMapping, 'documents' | 'unsynced' | 'leftOut'> {
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
      unsynced.push({ path: entry.path, reason: 'not-a-regular-file' });
      continue;
    }
    const content = contents.get(entry.oid);
    if (content === undefined) throw new Error(`the content of ${entry.path} was not read`);
    const problem = contentProblem(content);
    if (problem !== null) {
      unsynced.push({ path: entry.path, reason: problem });
      continue;
    }
    mapped.push({ path: entry.path, oid: entry.oid, title: titleOf(entry.path, zone), place: placeOf(zone) });
  }
  const { documents, leftOut } = separateCollisions(mapped);
  return { documents, unsynced, leftOut };
}

/** Maps the files of a commit, reading only `README.md` files and the `.md` files under annotations. */
export async function loadMapping(git: Git, commit: Oid): Promise<RepositoryMapping> {
  const entries = await listTree(git, commit);
  const readmeEntries = annotationFiles(entries);
  const readmeBlobs = await readBlobs(git, readmeEntries.map((entry) => entry.oid));
  const readmes = new Map(readmeEntries.map((entry) => [entry.path, (readmeBlobs.get(entry.oid) as Buffer).toString('utf8')]));
  const { annotations, problems: readProblems } = collectAnnotations(readmes);
  const { zones, problems: zoneProblems } = resolveZones(annotations);
  const contents = await readBlobs(git, candidateFiles(entries, zones).map((entry) => entry.oid));
  return { annotations, zones, problems: [...readProblems, ...zoneProblems], ...mapFiles(entries, zones, contents) };
}

/** The key under which two titles in one place are the same document title. */
export function titleKey(place: Place, title: string): string {
  const where = place.kind === 'project' ? `project\0${place.team}\0${place.project}` : `team\0${place.team}`;
  return `${where}\0${title.normalize('NFC').toLowerCase()}`;
}

function separateCollisions(mapped: readonly MappedDocument[]): { documents: MappedDocument[]; leftOut: LeftOutFile[] } {
  const groups = new Map<string, MappedDocument[]>();
  for (const document of mapped) {
    const key = titleKey(document.place, document.title);
    groups.set(key, [...(groups.get(key) ?? []), document]);
  }
  const documents: MappedDocument[] = [];
  const leftOut: LeftOutFile[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      documents.push(group[0] as MappedDocument);
      continue;
    }
    for (const document of group) {
      leftOut.push({
        path: document.path,
        rule: 'duplicate-title',
        title: document.title,
        place: document.place,
        collidesWith: group.filter((other) => other !== document).map((other) => other.path),
      });
    }
  }
  return { documents, leftOut };
}

function titleOf(path: string, zone: Zone): string {
  const base = zone.projectFolder ?? zone.teamFolder;
  const relative = base === '' ? path : path.slice(base.length + 1);
  return relative.slice(0, -MARKDOWN_EXTENSION.length);
}

function placeOf(zone: Zone): Place {
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
  return entry.path.endsWith(MARKDOWN_EXTENSION) && entry.path.length > MARKDOWN_EXTENSION.length && !entry.path.endsWith(`/${MARKDOWN_EXTENSION}`);
}

/** A file whose bytes git stores as they are: not a symlink or a submodule. */
function isRegularFile(entry: TreeEntry): boolean {
  return entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755');
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

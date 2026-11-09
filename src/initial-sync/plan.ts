// The plan of an initial sync from git to Linear: which synchronized files
// are left out and why, which Linear document each remaining file matches by
// title, and what a confirmed run would create, overwrite and move to trash.
// Pure: the caller reads the files and lists the documents.

import { lintText } from '../format/index.ts';
import { LINEAR_FACTS, type LinearDocument, type LinearFacts, lengthRefusal } from '../linear/index.ts';
import { type MappedDocument, type Place, type RepositoryMapping, type Zone } from '../mapping/index.ts';
import { type ResolvedTargets, projectKey } from '../setup/index.ts';

/**
 * Why a synchronized file stays in git only: a lint rule, a title collision,
 * or a title Linear refuses; in a dry run also a linked file the write would
 * refuse (`upload-too-large`, `upload-unreadable`, see `leaveOutAtWrite`).
 */
export interface LeftOutEntry {
  path: string;
  /** Sorted, each rule once. */
  rules: string[];
  /** 1-based lines of the lint findings, front matter included. */
  lines: number[];
  /** For `duplicate-title`: the other files with the same title in the same place. */
  collidesWith?: string[];
  /** The Linear document with the file's title, which the run leaves as it is. */
  documentId?: string;
  /** For a rule found from the files the document links (`upload-too-large`, `upload-unreadable`): those files. */
  files?: string[];
}

export interface CreateEntry {
  path: string;
  title: string;
  place: Place;
}

export interface OverwriteEntry {
  path: string;
  title: string;
  place: Place;
  documentId: string;
}

/** A Linear document no synchronized file matches; `path` is where its file would be. */
export interface TrashEntry {
  path: string;
  title: string;
  place: Place;
  documentId: string;
}

export interface InitialSyncPlan {
  create: CreateEntry[];
  overwrite: OverwriteEntry[];
  trash: TrashEntry[];
  leftOut: LeftOutEntry[];
}

/** One place's live documents (archived and trashed ones are not listed). */
export interface PlaceDocuments {
  place: Place;
  documents: readonly LinearDocument[];
}

export interface PlanInput {
  mapping: RepositoryMapping;
  /** The text of every mapped document's blob, by path. */
  texts: ReadonlyMap<string, string>;
  places: readonly PlaceDocuments[];
  facts?: LinearFacts;
}

/** Every place an annotation makes: each project, and each team zone (a team folder without a project). */
export function annotatedPlaces(zones: ReadonlyMap<string, Zone>): Array<{ place: Place; folder: string }> {
  const places = new Map<string, { place: Place; folder: string }>();
  for (const zone of [...zones.values()].sort((a, b) => compare(zoneFolder(a), zoneFolder(b)))) {
    const place: Place = zone.project !== undefined ? { kind: 'project', team: zone.team, project: zone.project } : { kind: 'team', team: zone.team };
    const key = placeKey(place);
    if (!places.has(key)) places.set(key, { place, folder: zoneFolder(zone) });
  }
  return [...places.values()];
}

/** The Linear id of a place, from the setup check's resolved targets. */
export function placeId(targets: ResolvedTargets, place: Place): { projectId: string } | { teamId: string } {
  if (place.kind === 'project') {
    const project = targets.projects.get(projectKey(place.team, place.project));
    if (project === undefined) throw new Error(`project "${place.project}" of team "${place.team}" was not resolved`);
    return { projectId: project.id };
  }
  const team = targets.teams.get(place.team);
  if (team === undefined) throw new Error(`team "${place.team}" was not resolved`);
  return { teamId: team.id };
}

export function placeKey(place: Place): string {
  return place.kind === 'project' ? `project\0${place.team}\0${place.project}` : `team\0${place.team}`;
}

/**
 * Builds the plan. A file is left out when the linter reports it, when its
 * title collides with another file's, when its title is longer than Linear
 * accepts, or when git does not store it as text; a left-out file's
 * document, if any, is neither overwritten nor trashed. A document matches
 * a file by title (see `titleIn`); when several live documents share that
 * title, the oldest is the match and the others go to trash.
 */
export function planInitialSync(input: PlanInput): InitialSyncPlan {
  const facts = input.facts ?? LINEAR_FACTS;
  const { mapping } = input;
  const leftOut = new Map<string, LeftOutEntry>();
  const leaveOut = (path: string, rules: string[], lines: number[] = [], collidesWith?: string[]) => {
    const entry = leftOut.get(path) ?? { path, rules: [], lines: [] };
    entry.rules = [...new Set([...entry.rules, ...rules])].sort();
    entry.lines = [...new Set([...entry.lines, ...lines])].sort((a, b) => a - b);
    if (collidesWith !== undefined) entry.collidesWith = [...collidesWith].sort(compare);
    leftOut.set(path, entry);
  };

  const textOf = (path: string): string => {
    const text = input.texts.get(path);
    if (text === undefined) throw new Error(`the text of ${path} was not read`);
    return text;
  };
  // Every reason a file stays in git only, so that fixing one does not reveal the next.
  const lint = (path: string, title: string) => {
    const findings = lintText(path, textOf(path));
    if (findings.length > 0) leaveOut(path, findings.map((f) => f.rule), findings.map((f) => f.line));
    if (lengthRefusal({ title }, facts) !== undefined) leaveOut(path, ['title-too-long']);
  };

  // Titles of left-out files, by place: their documents stay untouched.
  const leftOutTitles = new Map<string, string>();
  for (const file of mapping.leftOut) {
    leaveOut(file.path, [file.rule], [], file.collidesWith);
    lint(file.path, file.title);
    leftOutTitles.set(titleIn(file.place, file.title), file.path);
  }
  // A Markdown file under an annotation that git does not store as text (in LFS, binary, a link).
  for (const file of mapping.unsynced) {
    if (file.place === undefined || file.title === undefined) continue;
    leaveOut(file.path, [file.reason]);
    leftOutTitles.set(titleIn(file.place, file.title), file.path);
  }
  const synced: MappedDocument[] = [];
  for (const document of mapping.documents) {
    lint(document.path, document.title);
    if (leftOut.has(document.path)) leftOutTitles.set(titleIn(document.place, document.title), document.path);
    else synced.push(document);
  }

  const plan: InitialSyncPlan = { create: [], overwrite: [], trash: [], leftOut: [] };
  const filesByTitle = new Map(synced.map((document) => [titleIn(document.place, document.title), document]));
  const matched = new Set<string>();
  const folders = new Map(annotatedPlaces(mapping.zones).map(({ place, folder }) => [placeKey(place), folder]));
  for (const { place, documents } of input.places) {
    const oldestFirst = [...documents].sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id));
    for (const document of oldestFirst) {
      if (document.trashed || document.archivedAt !== null) continue;
      const key = titleIn(place, document.title);
      const file = filesByTitle.get(key);
      if (file !== undefined && !matched.has(key)) {
        matched.add(key);
        plan.overwrite.push({ path: file.path, title: file.title, place, documentId: document.id });
        continue;
      }
      const leftOutPath = leftOutTitles.get(key);
      if (leftOutPath !== undefined) {
        const entry = leftOut.get(leftOutPath) as LeftOutEntry;
        if (entry.documentId === undefined) {
          entry.documentId = document.id;
          continue;
        }
      }
      const folder = folders.get(placeKey(place)) ?? '';
      plan.trash.push({ path: `${folder === '' ? '' : `${folder}/`}${document.title}.md`, title: document.title, place, documentId: document.id });
    }
  }
  for (const document of synced) {
    if (!matched.has(titleIn(document.place, document.title))) plan.create.push({ path: document.path, title: document.title, place: document.place });
  }

  const byPath = <T extends { path: string }>(entries: T[]) => entries.sort((a, b) => compare(a.path, b.path));
  plan.create = byPath(plan.create);
  plan.overwrite = byPath(plan.overwrite);
  plan.trash = byPath(plan.trash);
  plan.leftOut = byPath([...leftOut.values()]);
  return plan;
}

/**
 * The plan with documents that the write would leave out (a linked file over
 * the upload limit) moved from create and overwrite to the left-out files,
 * with their rule and the files that cause it. An overwritten document stays
 * as it is, as the confirmed run leaves it.
 */
export function leaveOutAtWrite(plan: InitialSyncPlan, entries: ReadonlyArray<{ path: string; rule: string; files: readonly string[] }>): InitialSyncPlan {
  if (entries.length === 0) return plan;
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const leftOut = [...plan.leftOut];
  const add = (path: string, documentId?: string) => {
    const found = byPath.get(path);
    if (found === undefined) return;
    leftOut.push({ path, rules: [found.rule], lines: [], files: [...found.files], ...(documentId !== undefined ? { documentId } : {}) });
  };
  for (const entry of plan.create) add(entry.path);
  for (const entry of plan.overwrite) add(entry.path, entry.documentId);
  return {
    create: plan.create.filter((entry) => !byPath.has(entry.path)),
    overwrite: plan.overwrite.filter((entry) => !byPath.has(entry.path)),
    trash: plan.trash,
    leftOut: leftOut.sort((a, b) => compare(a.path, b.path)),
  };
}

/**
 * A document matches a file when its title equals the file's title in the
 * same place, compared in Unicode NFC (a file name may be stored decomposed)
 * and with case: a title that differs only in case is another document.
 */
function titleIn(place: Place, title: string): string {
  return `${placeKey(place)}\0${title.normalize('NFC')}`;
}

function zoneFolder(zone: Zone): string {
  return zone.projectFolder ?? zone.teamFolder;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

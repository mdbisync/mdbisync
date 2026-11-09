// The corpus as the harness reads it from the sandbox's main branch:
//
// - `corpus/` holds the files;
// - `corpus-slices/<slice>.json` is {"slice", "paths"}: the closed list of a
//   slice's files, relative to `corpus/`;
// - `corpus-slices/manifest.json` describes every file (group, kind, synced,
//   lfs, canary, class, rule).
//
// A run's tracked branch holds one slice at the repository root, with the
// project placeholders of the annotations replaced by the run's projects,
// and the team-zone files moved below a folder named after the run, so their
// titles start with the run id.

import { runNames, type RunNames } from './isolation.ts';
import { CHECK_WORKFLOW_PATH } from '../../corpus/check-workflow.ts';
import { findFrontMatter } from '../../../src/mapping/front-matter.ts';

export const CORPUS_DIR = 'corpus';
export const SLICES_DIR = 'corpus-slices';

export interface ManifestFile {
  path: string;
  group: string;
  kind: 'markdown' | 'image' | 'attachment' | 'other';
  synced: boolean;
  lfs: boolean;
  canary: string | null;
  /** Where the canary is: in the content, or in the file name (files that hold no text). */
  canary_in?: "content" | "name" | null;
  class: 'fixable' | 'lint-error' | 'unchanged' | null;
  rule: string | null;
  basis?: 'known' | 'assumed' | null;
  macos_unsafe?: boolean;
  /**
   * A stable name for a file a scenario speaks of by role (for example
   * `pdf-11mb`, `image-over-10mb`), so specs do not depend on corpus paths.
   */
  role?: string | null;
}

export interface Manifest {
  seed: string;
  files: ManifestFile[];
}

export interface SliceList {
  slice: string;
  paths: string[];
}

/** Placeholders the corpus uses in `linear-project:` annotations, in the order of the run's project names. */
export const PROJECT_PLACEHOLDERS = [
  'PROJECT_ENG_1',
  'PROJECT_ENG_2',
  'PROJECT_ENG_3',
  'PROJECT_ENG_4',
  'PROJECT_DOCS_1',
  'PROJECT_DOCS_2',
  'PROJECT_DOCS_3',
  'PROJECT_COMBINED',
  'PROJECT_ENG_5',
  'PROJECT_ENG_6',
] as const;

export function parseManifest(text: string): Manifest {
  const value = JSON.parse(text) as Manifest;
  if (!Array.isArray(value.files)) throw new Error('corpus manifest has no files list');
  return value;
}

export function parseSlice(text: string, slice: string): SliceList {
  const value = JSON.parse(text) as SliceList;
  if (value.slice !== slice || !Array.isArray(value.paths)) throw new Error(`slice file for ${slice} is malformed`);
  return value;
}

export interface Annotation {
  team: string | null;
  project: string | null;
}

/** Reads `linear-team` and `linear-project` from a README's front matter. */
export function readAnnotation(text: string): Annotation | null {
  const yaml = findFrontMatter(text)?.yaml;
  if (yaml === undefined) return null;
  const field = (name: string) => new RegExp(`^${name}:\\s*["']?([^"'\\r\\n]+?)["']?\\s*$`, 'm').exec(yaml)?.[1] ?? null;
  const team = field('linear-team');
  const project = field('linear-project');
  return team === null && project === null ? null : { team, project };
}

export interface Folder {
  folder: string;
  team: string | null;
  project: string | null;
}

/** The annotated folders of a slice: every README.md with an annotation. */
export function annotatedFolders(readmes: ReadonlyMap<string, string>): Folder[] {
  const folders: Folder[] = [];
  for (const [path, text] of readmes) {
    if (!/(^|\/)README\.md$/.test(path)) continue;
    const annotation = readAnnotation(text);
    if (annotation === null) continue;
    folders.push({ folder: path.replace(/\/?README\.md$/, ''), ...annotation });
  }
  return folders.sort((a, b) => a.folder.localeCompare(b.folder));
}

function inside(path: string, folder: string): boolean {
  return folder === '' || path.startsWith(`${folder}/`);
}

/** The nearest annotated folder above a path, or null. */
export function owningFolder(path: string, folders: readonly Folder[]): Folder | null {
  let best: Folder | null = null;
  for (const folder of folders) {
    if (inside(path, folder.folder) && (best === null || folder.folder.length > best.folder.length)) best = folder;
  }
  return best;
}

/** Team zones: folders that name a team and no project. */
export function teamZones(folders: readonly Folder[]): Folder[] {
  return folders.filter((folder) => folder.team !== null && folder.project === null);
}

export interface RunTree {
  /** New path → source path in `corpus/` (null source: content given in `rewritten`). */
  paths: Map<string, string>;
  /** New path → new text, for annotation READMEs whose placeholders were replaced. */
  rewritten: Map<string, string>;
  /** Placeholder → the run's project name, for the placeholders the slice uses. */
  projects: Map<string, string>;
  /** Team key → folder in the run's tree, for the team zones the slice uses. */
  teamZones: Map<string, string>;
  /** The teams any annotation of the slice names. */
  teams: Set<string>;
}

/**
 * Lays a slice out as a run's tracked tree. `readmes` holds the text of the
 * slice's README.md files (paths relative to `corpus/`).
 */
export function buildRunTree(slice: SliceList, readmes: ReadonlyMap<string, string>, names: RunNames = runNames('000000')): RunTree {
  const folders = annotatedFolders(readmes);
  const zones = teamZones(folders);
  const projects = new Map<string, string>();
  const rewritten = new Map<string, string>();
  const paths = new Map<string, string>();
  const teams = new Set<string>();

  for (const folder of folders) if (folder.team !== null) teams.add(folder.team);

  for (const source of slice.paths) {
    if (source.startsWith('.github/') && source !== CHECK_WORKFLOW_PATH) continue;
    let target = source;
    const owner = owningFolder(source, folders);
    if (owner !== null && zones.includes(owner) && source !== `${owner.folder}/README.md` && source !== 'README.md') {
      const rest = owner.folder === '' ? source : source.slice(owner.folder.length + 1);
      target = owner.folder === '' ? `${names.runId}/${rest}` : `${owner.folder}/${names.runId}/${rest}`;
    }
    paths.set(target, source);
    const text = readmes.get(source);
    if (text !== undefined) {
      const annotation = readAnnotation(text);
      if (annotation?.project !== null && annotation?.project !== undefined) {
        const index = (PROJECT_PLACEHOLDERS as readonly string[]).indexOf(annotation.project);
        if (index < 0) throw new Error(`unknown project placeholder in ${source}: ${annotation.project}`);
        const name = names.project(index);
        projects.set(annotation.project, name);
        rewritten.set(target, text.split(annotation.project).join(name));
      }
    }
  }
  const zoneMap = new Map<string, string>();
  for (const zone of zones) {
    if (zone.team !== null && slice.paths.some((path) => path !== `${zone.folder}/README.md` && owningFolder(path, folders) === zone)) {
      zoneMap.set(zone.team, zone.folder === '' ? names.runId : `${zone.folder}/${names.runId}`);
    }
  }
  return { paths, rewritten, projects, teamZones: zoneMap, teams };
}

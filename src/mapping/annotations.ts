// Folder annotations: `linear-team` and `linear-project` in the front matter
// of a folder's `README.md` say which Linear team and project the folder
// maps to. Folders without one inherit from their parent.

import { findFrontMatter, parseQuietly } from './front-matter.ts';
import { message } from '../messages.ts';
import { type AnnotationProblemKind } from '../codes.ts';

export const ANNOTATION_FILE = 'README.md';
export const TEAM_KEY = 'linear-team';
export const PROJECT_KEY = 'linear-project';

export interface Annotation {
  /** The annotated folder, `''` for the repository root. */
  folder: string;
  /** The `README.md` that holds the annotation. */
  readme: string;
  team?: string;
  project?: string;
}

export type { AnnotationProblemKind } from '../codes.ts';

/** An annotation the run cannot use. The message names paths and keys, never file content. */
export interface AnnotationProblem {
  readme: string;
  kind: AnnotationProblemKind;
  message: string;
}

export type ReadAnnotation = { annotation: Annotation | null } | { problem: AnnotationProblem };

const MENTIONS_KEY = new RegExp(`^[ \\t]*["']?(?:${TEAM_KEY}|${PROJECT_KEY})["']?[ \\t]*:`, 'm');

/**
 * Reads the annotation of one `README.md`. Returns `annotation: null` when
 * the file has no annotation keys. Front matter that does not parse is a
 * problem only when it mentions an annotation key; other front matter is the
 * file's own business.
 */
export function readAnnotation(readme: string, text: string): ReadAnnotation {
  const folder = folderOf(readme);
  const frontMatter = findFrontMatter(text);
  if (frontMatter === null) return { annotation: null };

  let data: unknown;
  try {
    data = parseQuietly(frontMatter.yaml);
  } catch {
    if (!MENTIONS_KEY.test(frontMatter.yaml)) return { annotation: null };
    return { problem: { readme, kind: 'invalid-annotation', message: message('annotations.invalid-yaml', { readme, teamKey: TEAM_KEY, projectKey: PROJECT_KEY }) } };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { annotation: null };

  const annotation: Annotation = { folder, readme };
  for (const [key, field] of [[TEAM_KEY, 'team'], [PROJECT_KEY, 'project']] as const) {
    if (!Object.hasOwn(data, key)) continue;
    const value = (data as Record<string, unknown>)[key];
    if (typeof value !== 'string' || value.trim() === '') {
      return { problem: { readme, kind: 'invalid-annotation', message: message('annotations.empty-name', { readme, key }) } };
    }
    annotation[field] = value.trim();
  }
  return { annotation: annotation.team === undefined && annotation.project === undefined ? null : annotation };
}

/** The effective team and project of an annotated folder, after inheritance. */
export interface Zone {
  team: string;
  /** The folder whose annotation names the team. */
  teamFolder: string;
  project?: string;
  /** The folder whose annotation names the project. */
  projectFolder?: string;
}

/**
 * Resolves inheritance: a folder names the team, a folder below it (or the
 * same folder) names the project, and every folder below inherits both. A
 * second team or project below an annotated one, or a project without a
 * team, is a problem; such an annotation is not used.
 */
export function resolveZones(annotations: readonly Annotation[]): { zones: Map<string, Zone>; problems: AnnotationProblem[] } {
  const zones = new Map<string, Zone>();
  const problems: AnnotationProblem[] = [];
  const ordered = [...annotations].sort((a, b) => depth(a.folder) - depth(b.folder) || compare(a.folder, b.folder));
  for (const annotation of ordered) {
    const inherited = nearestZone(zones, parentOf(annotation.folder));
    const { readme } = annotation;
    if (annotation.team !== undefined && inherited !== undefined) {
      problems.push({ readme, kind: 'nested-team', message: message('annotations.nested-team', { readme, team: inherited.team, folder: display(inherited.teamFolder) }) });
      continue;
    }
    if (annotation.project !== undefined && inherited?.project !== undefined) {
      problems.push({
        readme,
        kind: 'nested-project',
        message: message('annotations.nested-project', { readme, project: inherited.project, folder: display(inherited.projectFolder ?? '') }),
      });
      continue;
    }
    if (annotation.team === undefined && inherited === undefined) {
      problems.push({ readme, kind: 'project-without-team', message: message('annotations.project-without-team', { readme }) });
      continue;
    }
    const zone: Zone = annotation.team !== undefined
      ? { team: annotation.team, teamFolder: annotation.folder }
      : { ...(inherited as Zone) };
    if (annotation.project !== undefined) {
      zone.project = annotation.project;
      zone.projectFolder = annotation.folder;
    }
    zones.set(annotation.folder, zone);
  }
  return { zones, problems };
}

/** The zone of the nearest annotated folder at or above `folder`. */
export function nearestZone(zones: ReadonlyMap<string, Zone>, folder: string | null): Zone | undefined {
  for (let current = folder; current !== null; current = parentOf(current)) {
    const zone = zones.get(current);
    if (zone !== undefined) return zone;
  }
  return undefined;
}

export function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** The parent folder, or null above the root. */
export function parentOf(folder: string): string | null {
  return folder === '' ? null : folderOf(folder);
}

function depth(folder: string): number {
  return folder === '' ? 0 : folder.split('/').length;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function display(folder: string): string {
  return folder === '' ? 'the repository root' : `${folder}/`;
}

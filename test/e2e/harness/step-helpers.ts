// Helpers the step executors, the setup fixtures and the subjects share:
// which document a step targets, commits as a person, edits as an editor,
// and the run's view of its ids map.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readIds, stateRef, resolveStateConfig, type Git, type IdMap } from '../../../src/state/index.ts';
import { ordinalOf } from './conflicts.ts';
import { annotatedFolders, annotationPath, inheritedTeam } from './corpus.ts';
import type { HelperPurpose } from './isolation.ts';
import type { Project } from './linear-world.ts';
import { nextToken, type Editor, type RunContext } from './context.ts';
import { EnvBlockedError, ProductError } from './results.ts';
import { pullTracked } from './person-git.ts';
import { personCommit } from './sandbox.ts';

export function live(ctx: RunContext) {
  if (ctx.live === null) throw new Error('this step needs the sandbox and Linear, but the scenario runs offline');
  return ctx.live;
}

/** Synced Markdown documents of the run's tree (not annotation READMEs), sorted. */
export function documentPaths(ctx: RunContext): string[] {
  const world = live(ctx);
  const synced = new Set(world.manifest.files.filter((file) => file.synced && file.kind === 'markdown' && file.class !== 'lint-error').map((file) => file.path));
  return [...world.tree.paths].filter(([, source]) => synced.has(source) && !/(^|\/)README\.md$/.test(source)).map(([target]) => target).sort();
}

/**
 * The scenario's target document: a named path or path suffix; `<ordinal>-document`
 * and `other-document` pick by position; `project-document` picks by position
 * among the documents inside a project folder, whichever teams the run
 * selected; a paragraph target or none picks the scenario's fixture document
 * when setup made one, else the first document.
 */
export function targetPath(ctx: RunContext, target?: unknown, offset = 0): string {
  const paths = documentPaths(ctx);
  if (target === 'project-document') {
    const inProjects = paths.filter((path) => projectFolderOf(ctx, path) !== undefined);
    if (inProjects.length === 0) throw new EnvBlockedError('the slice has no synchronized document in a project');
    return pick(inProjects, offset);
  }
  if (typeof target === 'string') {
    if (target === 'other-document') return pick(paths, offset + 1);
    if (target.endsWith('-document') && ordinalOf(target) !== null) return pick(paths, (ordinalOf(target) as number) + offset);
    if (!target.endsWith('paragraph') && target !== 'document') {
      const found = paths.find((path) => path === target || path.endsWith(`/${target}`) || path.includes(target));
      if (found !== undefined) return found;
    }
  }
  const fixture = ctx.observations.get('fixture.document');
  if (typeof fixture === 'string' && offset === 0) return fixture;
  return pick(paths, offset);
}

function pick(paths: readonly string[], index: number): string {
  const path = paths[index % Math.max(1, paths.length)];
  if (path === undefined) throw new EnvBlockedError('the slice has no synchronized document to edit');
  return path;
}

/** Records the document a step acted on, for the subjects that speak of "the document". */
export function setTarget(ctx: RunContext, path: string, id?: string): void {
  if (!ctx.observations.has('target.path')) ctx.observations.set('target.path', path);
  const paths = (ctx.observations.get('target.paths') as string[] | undefined) ?? [];
  if (!paths.includes(path)) ctx.observations.set('target.paths', [...paths, path]);
  if (id !== undefined && !ctx.observations.has('target.id')) ctx.observations.set('target.id', id);
}

/** A path in the same folder as `path` (a file at the root stays at the root). */
export function sibling(path: string, name: string): string {
  const folder = path.split('/').slice(0, -1).join('/');
  return folder === '' ? name : `${folder}/${name}`;
}

/** The observation naming the project folder a cross-project move took the document out of. */
export const MOVE_SOURCE_FOLDER = 'move.sourceFolder';

/** Project folders of the run's tree (folders whose README names a project), longest first. */
export function projectFolders(ctx: RunContext): Array<{ folder: string; project: string }> {
  const world = live(ctx);
  const result: Array<{ folder: string; project: string }> = [];
  for (const [readme, text] of world.tree.rewritten) {
    // Relinked Markdown files are rewritten too; only a README annotates a folder.
    if (!/(^|\/)README\.md$/.test(readme)) continue;
    const name = [...world.tree.projects.values()].find((project) => text.includes(project));
    if (name !== undefined) result.push({ folder: readme.replace(/\/?README\.md$/, ''), project: name });
  }
  return result.sort((a, b) => b.folder.length - a.folder.length || a.folder.localeCompare(b.folder));
}

/** The project folder of the run's tree that holds `path` (the innermost), if any. */
export function projectFolderOf(ctx: RunContext, path: string): string | undefined {
  return projectFolders(ctx).find((candidate) => path.startsWith(`${candidate.folder}/`))?.folder;
}

/**
 * The team a folder's documents go to, read from a checkout: the team its own
 * README.md names, else the nearest one above it. Null when none names one.
 */
export function folderTeam(dir: string, folder: string): string | null {
  const readmes = new Map<string, string>();
  for (let current = folder; ; current = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '') {
    const readme = annotationPath({ folder: current });
    if (existsSync(join(dir, readme))) readmes.set(readme, readFileSync(join(dir, readme), 'utf8'));
    if (current === '') break;
  }
  return inheritedTeam(folder, annotatedFolders(readmes));
}

/**
 * Creates the run's helper project for `purpose` in a team (the workspace's first when none is named) and
 * registers it under `key` with the run's projects: cleanup deletes it and the checks read its documents.
 * A run holds one live project per helper name, so a second call for the same key is refused.
 */
export async function createHelperProject(ctx: RunContext, purpose: HelperPurpose, key: string, teamKey?: string): Promise<Project> {
  const world = live(ctx);
  if (world.projects.has(key)) throw new Error(`the run already has its ${purpose} helper project`);
  const team = teamKey === undefined ? [...world.teams.values()][0] : world.teams.get(teamKey);
  if (team === undefined) throw new EnvBlockedError(teamKey === undefined ? 'the test workspace has no team' : `the test workspace has no team ${teamKey}`);
  const project = await world.world.createProject(ctx.names.helperProject(purpose), [team.id]);
  world.projects.set(key, project);
  return project;
}

/**
 * Where a move goes. Specs name destinations by role: `project/<rest>` and
 * `same-project/<rest>` stay in the source's project folder;
 * `other-team/other-project/<rest>` goes to a project folder of another team.
 */
export function resolveDestination(ctx: RunContext, source: string, destination: string): string {
  const folders = projectFolders(ctx).map((entry) => entry.folder).sort();
  const own = folders.filter((folder) => source.startsWith(`${folder}/`)).sort((a, b) => b.length - a.length)[0];
  const top = (path: string) => path.split('/')[0];
  const match = /^(project|same-project|other-team\/other-project)\/(.+)$/.exec(destination);
  if (match === null) return destination;
  const rest = match[2] as string;
  if (match[1] === 'other-team/other-project') {
    const other = folders.find((folder) => top(folder) !== top(source));
    if (other === undefined) throw new EnvBlockedError('the slice has no project of another team to move to');
    return `${other}/${rest}`;
  }
  return own === undefined ? sibling(source, rest) : `${own}/${rest}`;
}

export async function readWorking(git: Git, path: string): Promise<string> {
  return readFileSync(join(git.dir, path), 'utf8');
}

export async function pull(git: Git, ctx: RunContext): Promise<void> {
  await pullTracked(git, ctx);
}

export async function commitAsPerson(ctx: RunContext, changes: Map<string, string | Buffer | null>, message: string, bypassHook = false): Promise<string> {
  const git = await ctx.person();
  // Before the pull: installing the hooks can take minutes, which would leave the pull stale.
  if (!bypassHook) await ctx.personHooks();
  await pull(git, ctx);
  const commit = await personCommit(git, ctx.names, changes, message, { verify: !bypassHook });
  ctx.ownCommits.push(commit);
  return commit;
}

/** The run's ids map as the engine last pushed it; null when there is no ids ref. */
export async function readRunIds(ctx: RunContext): Promise<IdMap | null> {
  const git = await ctx.person();
  const config = resolveStateConfig({ trackedBranch: ctx.names.trackedBranch, syncBranch: ctx.names.syncBranch, refPrefix: ctx.names.refPrefix });
  const ref = stateRef(config, 'ids');
  try {
    // Not into FETCH_HEAD: a load test's git edit pulls in the same clone while its Linear edits read the ids.
    await git.run(['fetch', '--quiet', '--no-write-fetch-head', 'origin', `+${ref}:${ref}`]);
  } catch {
    return null;
  }
  return readIds(git, (await git.text(['rev-parse', ref])).trim());
}

/** The Linear document id the engine recorded for a path, from the run's ids ref. */
export async function documentId(ctx: RunContext, path: string): Promise<string> {
  const ids = await readRunIds(ctx);
  if (ids === null) throw new ProductError(`no ids state ref: the engine has not recorded any document`);
  const entry = ids.get(path);
  if (entry === undefined) throw new ProductError(`the engine recorded no document for a target path`);
  return entry.id;
}

/** Reads a document's content as an editor, changes it and writes it back; records the edit for I2. */
export async function editorEdit(ctx: RunContext, editor: Editor, path: string, change: (text: string, token: string) => string | Promise<string>, removal = false): Promise<string> {
  const world = live(ctx);
  const id = await documentId(ctx, path);
  setTarget(ctx, path, id);
  const client = world.editors[editor];
  const [document] = await client.getDocuments([id], { withContent: true });
  if (document === undefined) throw new ProductError('a recorded document does not exist in Linear');
  const token = nextToken(ctx);
  const content = await change(document.content ?? '', token);
  const stored = await client.updateDocument(id, { content });
  ctx.observations.set('edited.linearStoredBody', stored.content ?? '');
  // Only an edit that wrote its token counts for I2 (a resolution or a removal writes none).
  if (removal || content.includes(token)) ctx.edits.push({ side: 'linear', path, token, ...(removal ? { removal } : {}) });
  ctx.observations.set('edited.linearBody', content);
  return token;
}

export function editorOf(args: Record<string, unknown>): Editor {
  return args.actor === 'editor-b' ? 'editor-b' : 'editor-a';
}

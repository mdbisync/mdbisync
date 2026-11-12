// Repository setup is local: validate the entire change before writing files.
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument, isMap, isSeq } from 'yaml';
import templates from './workflows.json' with { type: 'json' };
import type { CliResult } from '../cli.ts';
import { ANNOTATION_FILE, TEAM_KEY, PROJECT_KEY, resolveZones } from '../mapping/annotations.ts';
import { collectAnnotations } from '../mapping/mapping.ts';
import { appCreationUrl } from '../setup/app.ts';
import { QUICKSTART_URL } from '../setup/fixes.ts';
import { PROJECT_URL } from '../version.ts';
import { LINEAR_FORMAT_HOOK, PRE_COMMIT_CONFIG, SECURITY_ALIAS } from '../setup/hooks.ts';
import { findFrontMatter } from '../mapping/front-matter.ts';
import { message } from '../messages.ts';
import { MINIMUM_RELEASE, OLDER_RELEASES, RELEASE_PIN } from './releases.ts';

export const INIT_USAGE = `Usage: mdbisync init --release-sha <40-character SHA> [--release-version vX.Y.Z]
  --folder <path> --team <name> [--project <name>]   Repeat for each folder
  --security-hooks | --no-security-hooks           Optional examples (requires Docker)
The release must be ${MINIMUM_RELEASE.version} or later: the workflows use its action inputs.
Existing files and annotations are preserved; conflicting values must be resolved first.
`;

/** The flags `init` accepts: the ones that take a value, then the security choice. */
export const INIT_VALUE_FLAGS = ['--release-sha', '--release-version', '--folder', '--team', '--project'] as const;
export const INIT_SECURITY_FLAGS = ['--security-hooks', '--no-security-hooks'] as const;

interface Folder { path: string; team?: string; project?: string }
interface Settings { sha?: string; version?: string; security?: boolean; folders: Folder[] }
export interface InitOptions { cwd?: string; prompt?: (question: string) => Promise<string> }
class InitError extends Error {}

function parseArgs(args: readonly string[]): Settings {
  const settings: Settings = { folders: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if ((INIT_SECURITY_FLAGS as readonly string[]).includes(flag ?? '')) {
      if (settings.security !== undefined) throw new InitError(message('init.security-twice'));
      settings.security = flag === '--security-hooks';
      continue;
    }
    if (!(INIT_VALUE_FLAGS as readonly string[]).includes(flag ?? '')) throw new InitError(message('init.unknown-option', { option: String(flag) }));
    const value = args[++i];
    if (value === undefined || value.startsWith('--') || !value.trim()) throw new InitError(message('init.needs-value', { option: String(flag) }));
    if (flag === '--folder') settings.folders.push({ path: value });
    else if (flag === '--team' || flag === '--project') {
      const folder = settings.folders.at(-1);
      if (!folder) throw new InitError(message('init.must-follow-folder', { option: flag }));
      const key = flag === '--team' ? 'team' : 'project';
      if (folder[key] !== undefined) throw new InitError(message('init.given-twice-for-folder', { option: flag }));
      folder[key] = value.trim();
    } else {
      const key = flag === '--release-sha' ? 'sha' : 'version';
      if (settings[key] !== undefined) throw new InitError(message('init.given-twice', { option: String(flag) }));
      settings[key] = value;
    }
  }
  return settings;
}

async function optionalRead(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** Reject symlinks throughout a destination, including a dangling symlink. */
async function safePath(root: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..') || path.includes('\\')) throw new InitError(message('init.path-outside'));
  const target = resolve(root, path);
  if (relative(root, target).startsWith(`..${sep}`)) throw new InitError(message('init.path-outside'));
  let part = root;
  for (const component of relative(root, target).split(sep).filter(Boolean)) {
    part = join(part, component);
    try { if ((await lstat(part)).isSymbolicLink()) throw new InitError(message('init.symlink')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') throw new InitError(message('init.folder-is-file'));
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return target;
}

function document(text: string) {
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length || (!isMap(doc.contents) && doc.contents !== null)) throw new InitError(message('init.invalid-yaml'));
  return doc;
}

function annotate(text: string, folder: Folder): string {
  const fm = findFrontMatter(text);
  const doc = document(fm?.yaml ?? '');
  let changed = false;
  for (const [key, value] of [[TEAM_KEY, folder.team], [PROJECT_KEY, folder.project]] as const) {
    if (value === undefined) continue;
    if (doc.has(key)) {
      if (doc.get(key) !== value) throw new InitError(message('init.readme-differs', { folder: folder.path, key }));
    } else { doc.set(key, value); changed = true; }
  }
  if (!changed) return text;
  if (fm === null) {
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    const body = bom ? text.slice(1) : text;
    return `${bom}---\n${doc.toString({ lineWidth: 0 })}---\n${body}`;
  }
  // Replace only the YAML, leaving the fences, README body and line endings intact.
  const opening = /^﻿?---[^\S\r\n]*\r?\n/.exec(text)![0];
  const eol = opening.endsWith('\r\n') ? '\r\n' : '\n';
  return opening + doc.toString({ lineWidth: 0 }).replace(/\n/g, eol) + text.slice(opening.length + fm.yaml.length);
}

// The image digest pins the scanner's bytes as well as its version.
export const SCANNER_IMAGE = 'ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';
function hookConfig(text: string | undefined, settings: Settings): string {
  const doc = document(text ?? 'default_install_hook_types: [pre-commit, pre-push]\nrepos: []\n');
  const repos = doc.get('repos');
  if (!isSeq(repos)) throw new InitError(message('init.needs-repos', { file: PRE_COMMIT_CONFIG }));
  if (text === undefined) repos.flow = false;
  const data = doc.toJS() as { repos: Array<{ repo?: string; rev?: string; hooks?: Array<{ id?: string; [key: string]: unknown }> }> };
  if (data.repos.some((repo) => repo === null || typeof repo !== 'object' || !Array.isArray(repo.hooks) || repo.hooks.some((hook) => hook === null || typeof hook !== 'object' || typeof hook.id !== 'string'))) throw new InitError(message('init.invalid-repository-entry'));
  const existing = data.repos.filter((repo) => repo.hooks?.some((hook) => hook.id === LINEAR_FORMAT_HOOK));
  if (existing.some((repo) => repo.repo !== PROJECT_URL || repo.rev !== settings.sha)) throw new InitError(message('init.format-hook-differs'));
  let changed = text === undefined;
  if (!existing.length) {
    repos.add(doc.createNode({ repo: PROJECT_URL, rev: settings.sha, hooks: [{ id: LINEAR_FORMAT_HOOK }] }));
    changed = true;
  }
  if (settings.security) {
    const examples = [
      { id: 'gitleaks', name: 'Scan for secrets (Docker required)', alias: SECURITY_ALIAS, language: 'docker_image', entry: `${SCANNER_IMAGE} dir --redact --no-banner .`, pass_filenames: false, stages: ['pre-commit', 'pre-push'] },
      { id: 'private-key-pattern', name: 'Private key pattern', alias: SECURITY_ALIAS, language: 'pygrep', entry: '-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----', args: ['--multiline'], stages: ['pre-commit', 'pre-push'] },
    ];
    const hooks = data.repos.flatMap((repo) => repo.hooks ?? []);
    for (const example of examples) {
      const matches = hooks.filter((hook) => hook.id === example.id);
      for (const hook of matches) {
        const local = data.repos.some((repo) => repo.repo === 'local' && repo.hooks?.includes(hook));
        if (!local || Object.entries(example).some(([key, value]) => JSON.stringify(hook[key]) !== JSON.stringify(value))) {
          throw new InitError(message('init.security-hook-differs', { hook: example.id }));
        }
      }
    }
    const missing = examples.filter((hook) => !hooks.some((existing) => existing.id === hook.id));
    if (missing.length) { repos.add(doc.createNode({ repo: 'local', hooks: missing })); changed = true; }
  }
  return changed ? doc.toString({ lineWidth: 0 }) : text!;
}

/** The release flags: a well-formed SHA and version, not of a release older than the templates'. */
function checkRelease(settings: Settings): void {
  if (!/^[a-f0-9]{40}$/.test(settings.sha ?? '')) throw new InitError(message('init.release-sha'));
  if (settings.version !== undefined && !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(settings.version)) throw new InitError(message('init.release-version'));
  const older = Object.hasOwn(OLDER_RELEASES, settings.sha!) ? OLDER_RELEASES[settings.sha!] : Object.values(OLDER_RELEASES).find((version) => version === settings.version);
  if (older !== undefined) throw new InitError(message('init.release-too-old', { version: older, minimum: MINIMUM_RELEASE.version }));
}

export async function runInit(args: readonly string[], options: InitOptions = {}): Promise<CliResult> {
  if (args.includes('--help') || args.includes('-h')) return { exitCode: 0, stdout: INIT_USAGE, stderr: '' };
  try {
    const settings = parseArgs(args);
    const ask = options.prompt;
    const needsGuidance = !settings.sha || !settings.folders.length || settings.folders.some((folder) => !folder.team && !folder.project);
    if (ask && needsGuidance) {
      settings.sha ??= (await ask('Release commit SHA: ')).trim();
      checkRelease(settings);
      if (!settings.folders.length) settings.folders.push({ path: (await ask('Folder to synchronize: ')).trim() });
      for (const folder of settings.folders) {
        if (folder.team === undefined) {
          const team = (await ask(`Linear team for ${folder.path} (blank to keep or inherit): `)).trim();
          if (team) folder.team = team;
        }
        if (folder.project === undefined) {
          const project = (await ask(`Linear project for ${folder.path} (blank for team documents): `)).trim();
          if (project) folder.project = project;
        }
      }
      settings.security ??= /^(y|yes)$/i.test((await ask('Include security hook examples (requires Docker)? [y/N] ')).trim());
    }
    checkRelease(settings);
    if (!settings.folders.length || settings.folders.some((folder) => !folder.path.trim() || (!folder.team && !folder.project))) throw new InitError(message('init.needs-folder'));
    const root = await realpath(options.cwd ?? process.cwd());
    if (!await lstat(join(root, '.git')).catch(() => undefined)) throw new InitError(message('init.not-at-root'));
    const changes = new Map<string, string>();
    const queue = async (path: string, create: (before: string | undefined) => string) => {
      const target = await safePath(root, path);
      const before = await optionalRead(target);
      const after = create(before);
      if (changes.has(target) && changes.get(target) !== after) throw new InitError(message('init.conflicting-folders', { path }));
      if (before !== after) changes.set(target, after);
    };
    for (const [name, template] of Object.entries(templates)) {
      const content = template.replace(new RegExp(RELEASE_PIN, 'g'), `mdbisync/mdbisync@${settings.sha}${settings.version ? ` # ${settings.version}` : ''}`);
      await queue(`.github/workflows/${name}`, (before) => {
        if (before !== undefined && before !== content) throw new InitError(message('init.workflow-differs', { name }));
        return content;
      });
    }
    await queue(PRE_COMMIT_CONFIG, (before) => hookConfig(before, settings));
    for (const folder of settings.folders) await queue(join(folder.path, ANNOTATION_FILE), (before) => annotate(before ?? '', folder));
    // Include existing parent annotations when a project inherits its team.
    const contents = new Map<string, string>();
    const readmes = new Set<string>();
    for (const folder of settings.folders) {
      let path = resolve(root, folder.path);
      for (;;) {
        readmes.add(join(path, ANNOTATION_FILE));
        if (path === root) break;
        path = dirname(path);
      }
    }
    // A new parent annotation can invalidate an existing descendant mapping.
    const visited = new Set<string>();
    const descendants = async (folder: string): Promise<void> => {
      if (visited.has(folder)) return;
      visited.add(folder);
      readmes.add(join(folder, ANNOTATION_FILE));
      let entries;
      try { entries = await readdir(folder, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        if (entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name)) await descendants(join(folder, entry.name));
      }
    };
    for (const folder of settings.folders) await descendants(resolve(root, folder.path));
    for (const path of readmes) {
      await safePath(root, relative(root, path));
      const text = changes.get(path) ?? await optionalRead(path);
      if (text === undefined) continue;
      contents.set(relative(root, path), text);
    }
    const { annotations, problems } = collectAnnotations(contents);
    if (problems.length) throw new InitError(problems[0]!.message);
    const mapping = resolveZones(annotations);
    if (mapping.problems.length) throw new InitError(mapping.problems[0]!.message);
    for (const [path, text] of changes) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    return { exitCode: 0, stderr: '', stdout: `${changes.size ? `Wrote ${changes.size} repository files.` : 'Repository files are already initialized.'}\n\nRemaining admin steps:\n1. Create a Linear OAuth app with read,write client credentials; set repository secrets MDBISYNC_LINEAR_CLIENT_ID and MDBISYNC_LINEAR_CLIENT_SECRET.\n2. Create a GitHub App with contents, pull requests and workflows write, checks and commit statuses read (this link fills them in: ${appCreationUrl()}; for an organization's App see ${QUICKSTART_URL}#github-app), and install it on this repository. Set variable MDBISYNC_APP_CLIENT_ID and secret MDBISYNC_APP_PRIVATE_KEY.\n3. Allow merge commits; configure required checks for main.\n4. Install Node 24 and pre-commit; run pre-commit install and pre-commit install --hook-type pre-push. Security scanner examples also need Docker.\n5. Commit the files, run check, then dispatch initial sync with a direction and confirm unchecked for a dry run. Review its plan before confirming: the target side is overwritten.\n` };
  } catch (error) {
    if (!(error instanceof InitError)) throw error;
    return { exitCode: 2, stdout: '', stderr: `init: ${error.message}\n\n${INIT_USAGE}` };
  }
}

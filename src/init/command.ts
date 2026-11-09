// Repository setup is local: validate the entire change before writing files.
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseDocument, isMap, isSeq } from 'yaml';
import templates from './workflows.json' with { type: 'json' };
import type { CliResult } from '../cli.ts';
import { readAnnotation, resolveZones, type Annotation } from '../mapping/annotations.ts';
import { findFrontMatter } from '../mapping/front-matter.ts';

export const INIT_USAGE = `Usage: mdbisync init --release-sha <40-character SHA> [--release-version vX.Y.Z]
  --folder <path> --team <name> [--project <name>]   Repeat for each folder
  --security-hooks | --no-security-hooks           Optional examples (requires Docker)
Existing files and annotations are preserved; conflicting values must be resolved first.
`;

interface Folder { path: string; team?: string; project?: string }
interface Settings { sha?: string; version?: string; security?: boolean; folders: Folder[] }
export interface InitOptions { cwd?: string; prompt?: (question: string) => Promise<string> }
class InitError extends Error {}

function parseArgs(args: readonly string[]): Settings {
  const settings: Settings = { folders: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--security-hooks' || flag === '--no-security-hooks') {
      if (settings.security !== undefined) throw new InitError('choose security hooks once');
      settings.security = flag === '--security-hooks';
      continue;
    }
    if (!['--release-sha', '--release-version', '--folder', '--team', '--project'].includes(flag ?? '')) throw new InitError(`unknown option: ${flag}`);
    const value = args[++i];
    if (value === undefined || value.startsWith('--') || !value.trim()) throw new InitError(`${flag} needs a value`);
    if (flag === '--folder') settings.folders.push({ path: value });
    else if (flag === '--team' || flag === '--project') {
      const folder = settings.folders.at(-1);
      if (!folder) throw new InitError(`${flag} must follow --folder`);
      const key = flag === '--team' ? 'team' : 'project';
      if (folder[key] !== undefined) throw new InitError(`${flag} was given twice for a folder`);
      folder[key] = value.trim();
    } else {
      const key = flag === '--release-sha' ? 'sha' : 'version';
      if (settings[key] !== undefined) throw new InitError(`${flag} was given twice`);
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
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..') || path.includes('\\')) throw new InitError('paths must stay inside the repository');
  const target = resolve(root, path);
  if (relative(root, target).startsWith(`..${sep}`)) throw new InitError('paths must stay inside the repository');
  let part = root;
  for (const component of relative(root, target).split(sep).filter(Boolean)) {
    part = join(part, component);
    try { if ((await lstat(part)).isSymbolicLink()) throw new InitError('setup destinations must not contain symlinks'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}

function document(text: string) {
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length || (!isMap(doc.contents) && doc.contents !== null)) throw new InitError('invalid YAML configuration');
  return doc;
}

function annotate(text: string, folder: Folder): string {
  const fm = findFrontMatter(text);
  const doc = document(fm?.yaml ?? '');
  let changed = false;
  for (const [key, value] of [['linear-team', folder.team], ['linear-project', folder.project]] as const) {
    if (value === undefined) continue;
    if (doc.has(key)) {
      if (doc.get(key) !== value) throw new InitError(`${folder.path}/README.md already has a different ${key}`);
    } else { doc.set(key, value); changed = true; }
  }
  if (!changed) return text;
  if (fm === null) return `---\n${doc.toString()}---\n${text}`;
  // Replace only the YAML, leaving the fences, README body and line endings intact.
  const opening = /^﻿?---[^\S\r\n]*\r?\n/.exec(text)![0];
  const eol = opening.endsWith('\r\n') ? '\r\n' : '\n';
  return opening + doc.toString().replace(/\n/g, eol) + text.slice(opening.length + fm.yaml.length);
}

// The image digest pins the scanner's bytes as well as its version.
export const SCANNER_IMAGE = 'ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';
function hookConfig(text: string | undefined, settings: Settings): string {
  const doc = document(text ?? 'default_install_hook_types: [pre-commit, pre-push]\nrepos: []\n');
  const repos = doc.get('repos');
  if (!isSeq(repos)) throw new InitError('.pre-commit-config.yaml needs a repos list');
  const data = doc.toJS() as { repos: Array<{ repo?: string; rev?: string; hooks?: Array<{ id?: string }> }> };
  if (data.repos.some((repo) => repo === null || typeof repo !== 'object' || !Array.isArray(repo.hooks))) throw new InitError('invalid pre-commit repository entry');
  const existing = data.repos.filter((repo) => repo.hooks?.some((hook) => hook?.id === 'linear-format'));
  if (existing.some((repo) => repo.repo !== 'https://github.com/mdbisync/mdbisync' || repo.rev !== settings.sha)) throw new InitError('existing linear-format hook uses a different repository or release');
  let changed = text === undefined;
  if (!existing.length) {
    repos.add(doc.createNode({ repo: 'https://github.com/mdbisync/mdbisync', rev: settings.sha, hooks: [{ id: 'linear-format' }] }));
    changed = true;
  }
  if (settings.security) {
    const examples = [
      { id: 'gitleaks', name: 'Scan for secrets (Docker required)', alias: 'security', language: 'docker_image', entry: `${SCANNER_IMAGE} dir --redact --no-banner .`, pass_filenames: false, stages: ['pre-commit', 'pre-push'] },
      { id: 'private-key-pattern', name: 'Private key pattern', alias: 'security', language: 'pygrep', entry: '-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----', args: ['--multiline'], stages: ['pre-commit', 'pre-push'] },
    ];
    const ids = data.repos.flatMap((repo) => repo.hooks ?? []).map((hook) => hook.id);
    const missing = examples.filter((hook) => !ids.includes(hook.id));
    if (missing.length) { repos.add(doc.createNode({ repo: 'local', hooks: missing })); changed = true; }
  }
  return changed ? doc.toString() : text!;
}

export async function runInit(args: readonly string[], options: InitOptions = {}): Promise<CliResult> {
  if (args.includes('--help') || args.includes('-h')) return { exitCode: 0, stdout: INIT_USAGE, stderr: '' };
  try {
    const settings = parseArgs(args);
    const ask = options.prompt;
    if (ask) {
      settings.sha ??= (await ask('Release commit SHA: ')).trim();
      if (!settings.folders.length) settings.folders.push({ path: (await ask('Folder to synchronize: ')).trim() });
      for (const folder of settings.folders) {
        folder.team ??= (await ask(`Linear team for ${folder.path}: `)).trim();
        if (folder.project === undefined) {
          const project = (await ask(`Linear project for ${folder.path} (blank for team documents): `)).trim();
          if (project) folder.project = project;
        }
      }
      settings.security ??= /^(y|yes)$/i.test((await ask('Include security hook examples (requires Docker)? [y/N] ')).trim());
    }
    if (!/^[a-f0-9]{40}$/.test(settings.sha ?? '')) throw new InitError('--release-sha must be a full 40-character commit SHA');
    if (settings.version !== undefined && !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(settings.version)) throw new InitError('--release-version must be a version such as v1.2.3');
    if (!settings.folders.length || settings.folders.some((folder) => !folder.path.trim() || (!folder.team && !folder.project))) throw new InitError('provide --folder with --team and/or --project');
    const root = await realpath(options.cwd ?? process.cwd());
    if (!await lstat(join(root, '.git')).catch(() => undefined)) throw new InitError('run init at the repository root');
    const changes = new Map<string, string>();
    const queue = async (path: string, create: (before: string | undefined) => string) => {
      const target = await safePath(root, path);
      const before = await optionalRead(target);
      const after = create(before);
      if (changes.has(target) && changes.get(target) !== after) throw new InitError(`conflicting folder options: ${path}`);
      if (before !== after) changes.set(target, after);
    };
    for (const [name, template] of Object.entries(templates)) {
      const content = template.replace(/mdbisync\/mdbisync@[a-f0-9]{40} # v[^\s]+/g, `mdbisync/mdbisync@${settings.sha}${settings.version ? ` # ${settings.version}` : ''}`);
      await queue(`.github/workflows/${name}`, (before) => {
        if (before !== undefined && before !== content) throw new InitError(`existing workflow differs: ${name}`);
        return content;
      });
    }
    await queue('.pre-commit-config.yaml', (before) => hookConfig(before, settings));
    for (const folder of settings.folders) await queue(join(folder.path, 'README.md'), (before) => annotate(before ?? '', folder));
    // Include existing parent annotations when a project inherits its team.
    const annotations: Annotation[] = [];
    const readmes = new Set<string>();
    for (const folder of settings.folders) {
      let path = resolve(root, folder.path);
      for (;;) {
        readmes.add(join(path, 'README.md'));
        if (path === root) break;
        path = dirname(path);
      }
    }
    for (const path of readmes) {
      await safePath(root, relative(root, path));
      const text = changes.get(path) ?? await optionalRead(path);
      if (text === undefined) continue;
      const result = readAnnotation(relative(root, path), text);
      if ('problem' in result) throw new InitError(result.problem.message);
      if (result.annotation) annotations.push(result.annotation);
    }
    const mapping = resolveZones(annotations);
    if (mapping.problems.length) throw new InitError(mapping.problems[0]!.message);
    for (const [path, text] of changes) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    return { exitCode: 0, stderr: '', stdout: `${changes.size ? `Wrote ${changes.size} repository files.` : 'Repository files are already initialized.'}\n\nRemaining admin steps:\n1. Create a Linear OAuth app with read,write client credentials; set repository secrets MDBISYNC_LINEAR_CLIENT_ID and MDBISYNC_LINEAR_CLIENT_SECRET.\n2. Install a GitHub App with contents, pull requests and workflows write, checks and commit statuses read. Set variable MDBISYNC_APP_CLIENT_ID and secret MDBISYNC_APP_PRIVATE_KEY.\n3. Allow merge commits; configure required checks for main.\n4. Install Node 24 and pre-commit; run pre-commit install and pre-commit install --hook-type pre-push. Security scanner examples also need Docker.\n5. Commit the files, run check, then dispatch initial sync with a direction and confirm unchecked for a dry run. Review its plan before confirming: the target side is overwritten.\n` };
  } catch (error) {
    if (!(error instanceof InitError)) throw error;
    return { exitCode: 2, stdout: '', stderr: `init: ${error.message}\n\n${INIT_USAGE}` };
  }
}

/** Only the executable opens a terminal; library callers never prompt implicitly. */
export async function runTerminalInit(args: readonly string[]): Promise<CliResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return runInit(args);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return await runInit(args, { prompt: (question) => terminal.question(question) }); }
  finally { terminal.close(); }
}

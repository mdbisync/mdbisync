// Repository setup is local: validate the entire change before writing files.
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument, isMap, isScalar, isSeq } from 'yaml';
import templates from './workflows.json' with { type: 'json' };
import type { CliResult } from '../cli.ts';
import { PROJECT_KEY, TEAM_KEY } from '../mapping/annotations.ts';
import { appCreationUrl } from '../setup/app.ts';
import { QUICKSTART_URL } from '../setup/fixes.ts';
import { PROJECT_URL } from '../version.ts';
import { IGNORE_INLINE_ALLOW, LINEAR_FORMAT_HOOK, PRE_COMMIT_CONFIG, SECURITY_ALIAS } from '../setup/hooks.ts';
import { message } from '../messages.ts';
import { MINIMUM_RELEASE, OLDER_RELEASES, RELEASE_PIN } from './releases.ts';
import { ASSETS_FOLDER, UPLOAD_EXTENSIONS } from '../sync/upload-type.ts';

export const INIT_USAGE = `Usage: mdbisync init --release-sha <40-character SHA> [--release-version vX.Y.Z]
  --security-hooks | --no-security-hooks   Optional examples (requires Docker)
  --lfs | --no-lfs                         Store embedded files in Git LFS (.gitattributes)
The release must be ${MINIMUM_RELEASE.version} or later: the workflows use its action inputs.
Existing files are preserved; conflicting values must be resolved first.
`;

/** The flags `init` accepts: the ones that take a value, then the security and the Git LFS choices. */
export const INIT_VALUE_FLAGS = ['--release-sha', '--release-version'] as const;
export const INIT_SECURITY_FLAGS = ['--security-hooks', '--no-security-hooks'] as const;
export const INIT_LFS_FLAGS = ['--lfs', '--no-lfs'] as const;

export const GITATTRIBUTES = '.gitattributes';
const LFS = 'filter=lfs diff=lfs merge=lfs -text';
/**
 * The `.gitattributes` lines `init --lfs` adds: one per file type the sync
 * admits from Linear (and `.jpeg`), for files authored anywhere in git, and
 * the `assets/` folders the sync writes into, whatever a file's extension.
 */
export const LFS_ATTRIBUTES: readonly string[] = [
  ...[...UPLOAD_EXTENSIONS, '.jpeg'].map((extension) => `*${extension} ${LFS}`),
  `**/${ASSETS_FOLDER}/** ${LFS}`,
];

interface Settings { sha?: string; version?: string; security?: boolean; lfs?: boolean }
export interface InitOptions { cwd?: string; prompt?: (question: string) => Promise<string> }
class InitError extends Error {}

function parseArgs(args: readonly string[]): Settings {
  const settings: Settings = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if ((INIT_SECURITY_FLAGS as readonly string[]).includes(flag ?? '')) {
      if (settings.security !== undefined) throw new InitError(message('init.security-twice'));
      settings.security = flag === '--security-hooks';
      continue;
    }
    if ((INIT_LFS_FLAGS as readonly string[]).includes(flag ?? '')) {
      if (settings.lfs !== undefined) throw new InitError(message('init.lfs-twice'));
      settings.lfs = flag === '--lfs';
      continue;
    }
    if (!(INIT_VALUE_FLAGS as readonly string[]).includes(flag ?? '')) throw new InitError(message('init.unknown-option', { option: String(flag) }));
    const value = args[++i];
    if (value === undefined || value.startsWith('--') || !value.trim()) throw new InitError(message('init.needs-value', { option: String(flag) }));
    const key = flag === '--release-sha' ? 'sha' : 'version';
    if (settings[key] !== undefined) throw new InitError(message('init.given-twice', { option: String(flag) }));
    settings[key] = value;
  }
  return settings;
}

async function optionalRead(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/**
 * Reject symlinks throughout a destination, including a dangling symlink. init's destinations are fixed
 * names, so the path checks guard against a future caller rather than user input.
 */
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

/** The repository's attributes with every missing LFS line added after its own lines, which stay as they are. */
function lfsAttributes(text: string | undefined): string {
  const before = text ?? '';
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const present = new Set(before.split(/\r?\n/).map((line) => line.trim().replace(/\s+/g, ' ')));
  const missing = LFS_ATTRIBUTES.filter((line) => !present.has(line));
  if (!missing.length) return before;
  const lead = before === '' || before.endsWith('\n') ? '' : eol;
  return `${before}${lead}${missing.join(eol)}${eol}`;
}

// The image digest pins the scanner's bytes as well as its version.
export const SCANNER_IMAGE = 'ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';
// Document text comes from Linear, so an inline `gitleaks:allow` in it must not exempt a line;
// exceptions belong in the repository's tracked `.gitleaks.toml` or `.gitleaksignore`.
const SCANNER_ENTRY = `${SCANNER_IMAGE} dir --redact --no-banner ${IGNORE_INLINE_ALLOW} .`;
/** Entries earlier releases of init generated, which init updates to the current one. */
const EARLIER_SCANNER_ENTRIES: readonly string[] = [`${SCANNER_IMAGE} dir --redact --no-banner .`];
/** The secret scanner hook `init --security-hooks` adds. */
const SCANNER_HOOK: Readonly<Record<string, unknown>> & { id: string } = { id: 'gitleaks', name: 'Scan for secrets (Docker required)', alias: SECURITY_ALIAS, language: 'docker_image', entry: SCANNER_ENTRY, pass_filenames: false, stages: ['pre-commit', 'pre-push'] };
/** The optional security hooks `init --security-hooks` adds. Each has its own lists, so the YAML gets no anchors. */
const SECURITY_HOOK_EXAMPLES: ReadonlyArray<Readonly<Record<string, unknown>> & { id: string }> = [
  SCANNER_HOOK,
  { id: 'private-key-pattern', name: 'Private key pattern', alias: SECURITY_ALIAS, language: 'pygrep', entry: '-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----', args: ['--multiline'], stages: ['pre-commit', 'pre-push'] },
];
/** Whether a configured hook holds every key of the example with the same value. */
function sameHook(hook: Readonly<Record<string, unknown>>, example: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(example).every(([key, value]) => JSON.stringify(hook[key]) === JSON.stringify(value));
}

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
  // A scanner hook an earlier init generated gets the current entry, with or without --security-hooks.
  data.repos.forEach((repo, at) => {
    if (repo.repo !== 'local') return;
    repo.hooks!.forEach((hook, index) => {
      if (hook.id !== SCANNER_HOOK.id || !EARLIER_SCANNER_ENTRIES.includes(hook.entry as string) || !sameHook(hook, { ...SCANNER_HOOK, entry: hook.entry })) return;
      // A hook or entry shared through a YAML alias or anchor is not edited: the edit would reach the other uses too.
      const entry = doc.getIn(['repos', at, 'hooks', index, 'entry'], true);
      if (!isMap(doc.getIn(['repos', at, 'hooks', index], true)) || !isScalar(entry) || entry.anchor) throw new InitError(message('init.security-hook-differs', { hook: SCANNER_HOOK.id }));
      doc.setIn(['repos', at, 'hooks', index, 'entry'], SCANNER_ENTRY);
      hook.entry = SCANNER_ENTRY;
      changed = true;
    });
  });
  if (settings.security) {
    const hooks = data.repos.flatMap((repo) => repo.hooks ?? []);
    for (const example of SECURITY_HOOK_EXAMPLES) {
      const matches = hooks.filter((hook) => hook.id === example.id);
      for (const hook of matches) {
        const local = data.repos.some((repo) => repo.repo === 'local' && repo.hooks?.includes(hook));
        if (!local || !sameHook(hook, example)) {
          throw new InitError(message('init.security-hook-differs', { hook: example.id }));
        }
      }
    }
    const missing = SECURITY_HOOK_EXAMPLES.filter((hook) => !hooks.some((existing) => existing.id === hook.id));
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
    // With a terminal, init asks for what the flags left open: the release, then each of the two choices.
    if (ask) {
      settings.sha ??= (await ask('Release commit SHA: ')).trim();
      checkRelease(settings);
      settings.security ??= /^(y|yes)$/i.test((await ask('Include security hook examples (requires Docker)? [y/N] ')).trim());
      settings.lfs ??= /^(y|yes)$/i.test((await ask('Store embedded images and files in Git LFS? [y/N] ')).trim());
    }
    checkRelease(settings);
    const root = await realpath(options.cwd ?? process.cwd());
    if (!await lstat(join(root, '.git')).catch(() => undefined)) throw new InitError(message('init.not-at-root'));
    const changes = new Map<string, string>();
    const queue = async (path: string, create: (before: string | undefined) => string) => {
      const target = await safePath(root, path);
      const before = await optionalRead(target);
      const after = create(before);
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
    if (settings.lfs) await queue(GITATTRIBUTES, lfsAttributes);
    for (const [path, text] of changes) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    }
    const stdout = `${changes.size ? `Wrote ${changes.size} repository files.` : 'Repository files are already initialized.'}

Remaining admin steps:
1. Create a Linear OAuth app with read,write client credentials. Set repository variable MDBISYNC_LINEAR_CLIENT_ID. Set it before enabling the workflows. Remove any old repository secret for this client ID once the updated workflows are in place.
2. Create a GitHub App with contents, pull requests and workflows write, checks and commit statuses read (this link fills them in: ${appCreationUrl()}; for an organization's App see ${QUICKSTART_URL}#github-app), and install it on this repository. Set repository variable MDBISYNC_APP_CLIENT_ID.
3. In Settings → Environments, create mdbisync. Under Selected branches and tags, add only the tracked branch (main by default) as a Branch rule. Leave required reviewers off. Add environment secrets MDBISYNC_APP_PRIVATE_KEY and MDBISYNC_LINEAR_CLIENT_SECRET. Delete repository secrets of the same names once the workflows and environment are in place. Until the secrets move, the jobs still read repository secrets and sync keeps working, but the branch rule does not protect those secrets. For plan requirements and migration of existing workflows, see ${QUICKSTART_URL}#sync-environment.
4. Allow merge commits and configure required checks for main.
5. Install Node.js 24.2 or later and pre-commit. Run pre-commit install and pre-commit install --hook-type pre-push. Security scanner examples also need Docker.${settings.lfs ? ' Install Git LFS and run git lfs install.' : ''}
6. Mark each folder to synchronize in its README.md front matter: ${TEAM_KEY} names the Linear team, and ${PROJECT_KEY} a project for that folder's documents. A folder inside a team's folder takes that team and leaves out ${TEAM_KEY}.
7. Commit the files, run check, then dispatch initial sync with a direction and confirm unchecked for a dry run. Review its plan before confirming: the target side is overwritten.
`;
    return { exitCode: 0, stderr: '', stdout };
  } catch (error) {
    if (!(error instanceof InitError)) throw error;
    return { exitCode: 2, stdout: '', stderr: `init: ${error.message}\n\n${INIT_USAGE}` };
  }
}

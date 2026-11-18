// Hook output is untrusted: retain only configured hook ids and line numbers.
// Candidates stay in a disposable repository with no remote until accepted.
import { type FileContent, contentBytes } from '../state/content.ts';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { Git, type Oid, listTree, readBlobs, checkRepoPath, parseLfsPointer } from '../state/index.ts';
import { isGitDirectoryName } from '../state/objects.ts';
import { createHash } from 'node:crypto';
import { readHookConfig, PRE_COMMIT_CONFIG, SECURITY_ALIAS } from '../setup/hooks.ts';
import { isMarkdownPath } from '../mapping/index.ts';
import { message } from '../messages.ts';

export interface SecurityFinding { hook: string; line: number }
export interface SecurityGate {
  readonly configured: boolean;
  /**
   * The findings, none when the files pass; null when the gate has no answer
   * for these files (the staged steps): they are not pushed this run.
   */
  check(files: ReadonlyMap<string, FileContent>): Promise<SecurityFinding[] | null>;
  close?(): Promise<void>;
}

/** Neither errors nor returned findings contain raw hook output. */
function runHooks(dir: string, args: string[], env: Record<string, string | undefined>): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('pre-commit', args, { cwd: dir, env: { ...env, PRE_COMMIT_COLOR: 'never', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer) => { if (output.length < 2_000_000) output += chunk.toString('utf8'); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, output: '' }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, output }); });
  });
}

export interface SecurityGateOptions {
  /**
   * The hooks' whole environment. By default only `PATH`, `HOME` and `LANG`,
   * for hooks run inside the operation's own process. The staged hooks step
   * gives them its own environment, which holds only the keys the deployer
   * gives to hooks.
   */
  env?: Record<string, string | undefined>;
}

/** The ids of the tracked commit's security hooks; none without a configuration. */
export async function securityHookIds(git: Git, tracked: Oid): Promise<string[]> {
  const read = await git.run(['cat-file', 'blob', `${tracked}:${PRE_COMMIT_CONFIG}`], { okCodes: [0, 128] });
  const config = readHookConfig(read.code === 0 ? read.stdout.toString('utf8') : null);
  if (config.invalid !== undefined) throw new Error(message('sync.invalid-security-config'));
  return config.hooks.filter((hook) => hook.alias === SECURITY_ALIAS).map((hook) => hook.id);
}

/**
 * Whether the tracked files that differ from the index after the writes are all Markdown documents or same assets,
 * none of them a support file's link target.
 */
async function onlyDocumentsChanged(scratch: Git, dir: string, files: ReadonlyMap<string, FileContent>, linkedSupport: readonly string[]): Promise<boolean> {
  const changed = (await scratch.run(['diff', '--name-only', '--no-renames', '-z'])).stdout.toString('utf8').split('\0').filter((path) => path !== '');
  for (const path of changed) {
    // A support file reached through a tracked link stays as tracked, even where the link leads to a document.
    if (linkedSupport.some((target) => path === target || path.startsWith(`${target}/`))) return false;
    if (isMarkdownPath(path)) continue;
    const pointer = parseLfsPointer((await scratch.run(['cat-file', 'blob', `:${path}`])).stdout);
    const content = files.get(path);
    if (pointer === null || content === undefined) return false;
    const bytes = contentBytes(content);
    if (pointer.size !== bytes.length || pointer.oid !== createHash('sha256').update(bytes).digest('hex')) return false;
    // The file must hold what the candidate wrote: an alias written after it could have replaced it.
    if (!(await readFile(join(dir, path))).equals(bytes)) return false;
  }
  return true;
}

/** Whether `path`, or a folder on the way to it, is a symbolic link in `dir`, by the file system's own name lookup. */
async function throughLink(dir: string, path: string): Promise<boolean> {
  const parts = path.split('/');
  for (let at = 1; at <= parts.length; at++) {
    const found = await lstat(join(dir, ...parts.slice(0, at))).catch(() => null);
    if (found === null) return false;
    if (found.isSymbolicLink()) return true;
  }
  return false;
}

/**
 * Writes the tracked tree into the scratch repository, ignored files and symbolic links included, so the hooks see
 * the tree that is merged. Returns the scratch index's tree, and the paths that tracked symbolic links of support
 * files (any but Markdown documents) resolve to: a candidate may not change those either. Blobs are written and
 * indexed as stored, without filters. A symbolic link is reproduced only when it resolves inside the scratch tree
 * (not its `.git`); one that leads outside it or nowhere, or any other difference between the scratch index and the
 * tracked tree, throws, and the gate fails closed.
 */
async function reproduceTree(git: Git, tracked: Oid, scratch: Git, dir: string): Promise<{ tree: string; linkedSupport: string[] }> {
  const entries = await listTree(git, tracked);
  for (const entry of entries) checkRepoPath(entry.path);
  const files = entries.filter((entry) => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode));
  const links = entries.filter((entry) => entry.type === 'blob' && entry.mode === '120000');
  const gitlinks = entries.filter((entry) => entry.type === 'commit');
  // Read supporting files in bounded batches; large repositories are not held in memory.
  for (let at = 0; at < files.length; at += 32) {
    const batch = files.slice(at, at + 32);
    const blobs = await readBlobs(git, batch.map((entry) => entry.oid));
    for (const entry of batch) {
      await mkdir(dirname(join(dir, entry.path)), { recursive: true });
      await writeFile(join(dir, entry.path), blobs.get(entry.oid)!, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
    }
  }
  for (const entry of gitlinks) await mkdir(join(dir, entry.path), { recursive: true });
  // Links last, so no file above is written through one.
  const targets = await readBlobs(git, links.map((entry) => entry.oid));
  for (const entry of links) {
    await mkdir(dirname(join(dir, entry.path)), { recursive: true });
    await symlink(targets.get(entry.oid)!, join(dir, entry.path));
  }
  const root = await realpath(dir);
  const linkedSupport: string[] = [];
  for (const entry of links) {
    // Resolved once all links exist, so a chain of links is followed to its end. A link into the scratch
    // repository's own `.git` counts as outside: a candidate written through it could change its configuration.
    const target = await realpath(join(dir, entry.path));
    const inside = target.slice(root.length + 1).split(sep);
    if (!target.startsWith(root + sep) || isGitDirectoryName(inside[0]!)) throw new Error(message('sync.security-link-outside'));
    if (!isMarkdownPath(entry.path)) linkedSupport.push(inside.join('/'));
  }
  // No clean filter (Git LFS) or line-ending conversion: the index holds the bytes as the tracked tree stores them.
  await mkdir(join(dir, '.git', 'info'), { recursive: true });
  await writeFile(join(dir, '.git', 'info', 'attributes'), '* -text -filter -ident -working-tree-encoding\n');
  // Force-add: a tracked file that `.gitignore` names is still part of the tree the hooks check.
  await scratch.run(['add', '--all', '--force']);
  if (gitlinks.length > 0) {
    await scratch.run(['update-index', '-z', '--index-info'], { input: gitlinks.map((entry) => `160000 ${entry.oid}\t${entry.path}\0`).join('') });
  }
  const tree = await scratch.text(['write-tree']);
  if (tree !== await git.text(['rev-parse', `${tracked}^{tree}`])) throw new Error(message('sync.security-tree-differs'));
  return { tree, linkedSupport };
}

/** Uses the tracked branch's configuration and support files, never a Linear-supplied config. */
export async function securityGate(git: Git, tracked: Oid, options: SecurityGateOptions = {}): Promise<SecurityGate> {
  const env = options.env ?? { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' };
  const hooks = await securityHookIds(git, tracked);
  if (hooks.length > 0 && (await runHooks(git.dir, ['--version'], env)).code !== 0) throw new Error(message('sync.needs-pre-commit'));
  let dir: string | undefined;
  let scratch: Git;
  let baseline: string;
  let linkedSupport: string[] = [];
  const close = async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  };
  return {
    configured: hooks.length > 0,
    close,
    async check(files) {
      if (hooks.length === 0) return [];
      try {
        if (dir === undefined) {
          dir = await mkdtemp(join(tmpdir(), 'capture-security-'));
          scratch = new Git(dir);
          // The same object format, so the same tree has the same id in both repositories.
          await scratch.run(['init', '--quiet', `--object-format=${await git.text(['rev-parse', '--show-object-format'])}`]);
          ({ tree: baseline, linkedSupport } = await reproduceTree(git, tracked, scratch, dir));
        }
        // Restore only our disposable repository, including hook changes from the previous document.
        await scratch.run(['read-tree', '--reset', '-u', baseline]);
        await scratch.run(['clean', '-fdx', '--quiet']);
        for (const [path, content] of files) {
          checkRepoPath(path);
          // pre-commit and its hooks would read a path that starts with `-` as an option, such as `--config`.
          if (path === PRE_COMMIT_CONFIG || path.startsWith('-')) return [{ hook: SECURITY_ALIAS, line: 1 }];
          // A write through a tracked link would land in its target while the hooks are handed the link, which they
          // skip: a candidate at a link's path, or below one, is never checked, so it is refused.
          if (await throughLink(dir, path)) return [{ hook: SECURITY_ALIAS, line: 1 }];
          await mkdir(dirname(join(dir, path)), { recursive: true });
          await writeFile(join(dir, path), contentBytes(content));
        }
        // The hooks run the tracked branch's scripts and read its support files: a candidate replaces none of them,
        // so its text never becomes code the hooks run. Git, not the path's spelling, says which tracked files the
        // writes changed, so an alias the file system resolves to one (by case or otherwise) is caught as well. Only
        // documents may change, and an asset kept in LFS by the bytes its pointer names.
        if (!await onlyDocumentsChanged(scratch, dir, files, linkedSupport)) return [{ hook: SECURITY_ALIAS, line: 1 }];
        // Index-inspecting hooks see the candidate too. This repository has no remote.
        await scratch.run(['add', '--force', '--', ...files.keys()]);
        const findings: SecurityFinding[] = [];
        let ran = false;
        for (const stage of ['pre-commit', 'pre-push']) {
          const result = await runHooks(dir, ['run', SECURITY_ALIAS, '--hook-stage', stage, '--files', ...files.keys()], env);
          if (result.code !== 0 && result.output.trim() === `No hook with id \`security\` in stage \`${stage}\``) continue;
          ran = true;
          if (result.code !== 0) {
            const failed = hooks.filter((id) => result.output.includes(`- hook id: ${id}\n`));
            const escaped = [...files.keys()].map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
            const located = new RegExp(`(?:${escaped.join('|')}):(\\d+)(?::|\\b)`, 'g');
            const matches = [...result.output.matchAll(located)];
            const lines = matches.map((match) => Number(match[1])).filter((line) => Number.isSafeInteger(line) && line > 0);
            for (const hook of failed.length > 0 ? failed : [SECURITY_ALIAS]) findings.push({ hook, line: lines[0] ?? 1 });
          }
        }
        if (!ran) findings.push({ hook: SECURITY_ALIAS, line: 1 });
        // Capture only Linear's text. A security hook that rewrites it is a rejection.
        for (const [path, content] of files) {
          const after = await readFile(join(dir, path)).catch(() => null);
          if (after === null || !after.equals(contentBytes(content))) findings.push({ hook: SECURITY_ALIAS, line: 1 });
        }
        return findings;
      } catch {
        // Spawn, filesystem and configuration failures must fail closed without exposing content.
        return [{ hook: SECURITY_ALIAS, line: 1 }];
      }
    },
  };
}

// Hook output is untrusted: retain only configured hook ids and line numbers.
// Candidates stay in a disposable repository with no remote until accepted.
import { type FileContent, contentBytes } from '../state/content.ts';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { Git, GitOutputLimitError, type Oid, type TreeEntry, listTree, readBlobs, checkRepoPath, parseLfsPointer } from '../state/index.ts';
import { isGitDirectoryName } from '../state/objects.ts';
import { createHash } from 'node:crypto';
import { readHookConfig, securityHooks, PRE_COMMIT_CONFIG, SECURITY_ALIAS } from '../setup/hooks.ts';
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

interface ScratchSecurityGate extends SecurityGate {
  /** A clean union proves every member set passed. A failure must be resolved by checking smaller sets. */
  passesBatch?(files: ReadonlyMap<string, FileContent>): Promise<boolean>;
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

/** More bytes than any Git LFS pointer file holds. */
const LFS_POINTER_BYTES = 1024;

/** The most `cat-file` output one read of support files may produce; a larger file is streamed to disk alone. */
export const SCRATCH_BATCH_BYTES = 16 * 1024 * 1024;
/** The most files one read of support files asks for. */
const SCRATCH_BATCH_FILES = 32;
/** The most bytes of tracked files and link targets the scratch tree may hold by default. */
export const SCRATCH_TREE_BYTES = 4 * 1024 * 1024 * 1024;

/** The tracked tree is too large to reproduce for the hooks: the gate has no answer, and the run stops. */
export class SecurityScratchBudgetError extends Error {
  readonly code = 'security-scratch-budget';

  constructor(bytes: number) {
    super(message('sync.security-scratch-budget', { bytes }));
    this.name = 'SecurityScratchBudgetError';
  }
}

/**
 * The scratch repository does not hold the tracked tree as it is: most often on a file system that ignores case or
 * Unicode normalization, where two tracked paths that differ only by those become one file, or where Git stores a
 * path in another form; also when the tree lists a file without a valid size. The hooks would check another tree
 * than the one that is merged, so the gate has no answer for any document, and the run stops.
 */
export class SecurityScratchTreeError extends Error {
  readonly code = 'security-scratch-tree';

  constructor() {
    super(message('sync.security-scratch-tree'));
    this.name = 'SecurityScratchTreeError';
  }
}

/** The bytes `cat-file --batch` writes for a blob: "<oid> blob <size>\n", the content, and a final newline. */
function batchBytes(entry: TreeEntry & { size: number }): number {
  return entry.oid.length + String(entry.size).length + 8 + entry.size;
}

/** A blob entry's listed size, checked: a missing or impossible size stops the run. */
function blobSize(entry: TreeEntry): TreeEntry & { size: number } {
  if (entry.size === null || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new SecurityScratchTreeError();
  return entry as TreeEntry & { size: number };
}

/**
 * Refuses a tracked tree whose files and link targets exceed `budget` bytes, by the sizes the tree lists and before
 * any of them is read or any hook runs. Also checks every listed size, which the batched reads rely on.
 */
function checkScratchBudget(entries: readonly TreeEntry[], budget: number): void {
  let total = 0;
  for (const entry of entries) {
    if (entry.type === 'blob') total += blobSize(entry).size;
  }
  if (total > budget) throw new SecurityScratchBudgetError(budget);
}

/**
 * Reads blobs in batches of at most SCRATCH_BATCH_FILES files and SCRATCH_BATCH_BYTES of output, by the sizes the
 * tree lists (which checkScratchBudget has checked), and hands each batch to `use`. A blob too large for a batch goes to `alone` instead, unread.
 */
async function readInBatches(
  git: Git,
  entries: readonly TreeEntry[],
  use: (batch: readonly TreeEntry[], blobs: Map<Oid, Buffer>) => Promise<void>,
  alone: (entry: TreeEntry) => Promise<void>,
): Promise<void> {
  let batch: TreeEntry[] = [];
  let bytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const blobs = await readBlobs(git, batch.map((entry) => entry.oid), bytes);
    await use(batch, blobs);
    batch = [];
    bytes = 0;
  };
  for (const entry of entries) {
    const size = batchBytes(entry as TreeEntry & { size: number });
    if (size > SCRATCH_BATCH_BYTES) {
      await alone(entry);
      continue;
    }
    if (batch.length === SCRATCH_BATCH_FILES || bytes + size > SCRATCH_BATCH_BYTES) await flush();
    batch.push(entry);
    bytes += size;
  }
  await flush();
}

export interface SecurityGateOptions {
  /**
   * The hooks' whole environment. By default only `PATH`, `HOME` and `LANG`,
   * for hooks run inside the operation's own process. The staged hooks step
   * gives them its own environment, which holds only the keys the deployer
   * gives to hooks.
   */
  env?: Record<string, string | undefined>;
  /** The most bytes of tracked files and link targets the scratch tree may hold; SCRATCH_TREE_BYTES by default. */
  scratchBytes?: number;
}

async function trackedHookConfig(git: Git, tracked: Oid) {
  const read = await git.run(['cat-file', 'blob', `${tracked}:${PRE_COMMIT_CONFIG}`], { okCodes: [0, 128] });
  const config = readHookConfig(read.code === 0 ? read.stdout.toString('utf8') : null);
  if (config.invalid !== undefined) throw new Error(message('sync.invalid-security-config'));
  return config;
}

/** The ids of the tracked commit's security hooks; none without a configuration. */
export async function securityHookIds(git: Git, tracked: Oid): Promise<string[]> {
  return securityHooks(await trackedHookConfig(git, tracked));
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
    // Only an LFS pointer may differ, and a pointer is small: a larger tracked file is not read whole.
    const read = await scratch.run(['cat-file', 'blob', `:${path}`], { maxOutputBytes: LFS_POINTER_BYTES }).catch((error: unknown) => {
      if (error instanceof GitOutputLimitError) return null;
      throw error;
    });
    if (read === null) return false;
    const pointer = parseLfsPointer(read.stdout);
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
 * (not its `.git`); one that leads outside it or nowhere throws, and the gate fails closed. A scratch index that
 * differs from the tracked tree throws SecurityScratchTreeError: no document can be checked, and the run stops.
 */
async function reproduceTree(git: Git, tracked: Oid, entries: readonly TreeEntry[], scratch: Git, dir: string): Promise<{ tree: string; linkedSupport: string[] }> {
  for (const entry of entries) checkRepoPath(entry.path);
  const files = entries.filter((entry) => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode));
  const links = entries.filter((entry) => entry.type === 'blob' && entry.mode === '120000');
  const gitlinks = entries.filter((entry) => entry.type === 'commit');
  const fileMode = (entry: TreeEntry) => (entry.mode === '100755' ? 0o755 : 0o644);
  // Read supporting files in batches bounded by count and by the sizes the tree lists, so memory stays bounded
  // however large the repository; a file too large for a batch is streamed to disk on its own.
  await readInBatches(git, files, async (batch, blobs) => {
    for (const entry of batch) {
      await mkdir(dirname(join(dir, entry.path)), { recursive: true });
      await writeFile(join(dir, entry.path), blobs.get(entry.oid)!, { mode: fileMode(entry) });
    }
  }, async (entry) => {
    await mkdir(dirname(join(dir, entry.path)), { recursive: true });
    await git.runToFile(['cat-file', 'blob', entry.oid], join(dir, entry.path), fileMode(entry));
  });
  for (const entry of gitlinks) await mkdir(join(dir, entry.path), { recursive: true });
  // Links last, so no file above is written through one. No file system takes a link target as long as a batch.
  await readInBatches(git, links, async (batch, targets) => {
    for (const entry of batch) {
      await mkdir(dirname(join(dir, entry.path)), { recursive: true });
      await symlink(targets.get(entry.oid)!, join(dir, entry.path));
    }
  }, async () => {
    throw new Error(message('sync.security-link-outside'));
  });
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
  if (tree !== await git.text(['rev-parse', `${tracked}^{tree}`])) throw new SecurityScratchTreeError();
  return { tree, linkedSupport };
}

/** Uses the tracked branch's configuration and support files, never a Linear-supplied config. */
export async function securityGate(git: Git, tracked: Oid, options: SecurityGateOptions = {}): Promise<ScratchSecurityGate> {
  const env = options.env ?? { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' };
  const config = await trackedHookConfig(git, tracked);
  const hooks = securityHooks(config);
  if (hooks.length > 0 && (await runHooks(git.dir, ['--version'], env)).code !== 0) throw new Error(message('sync.needs-pre-commit'));
  const budget = options.scratchBytes ?? SCRATCH_TREE_BYTES;
  let dir: string | undefined;
  let scratch: Git;
  let baseline: string;
  let linkedSupport: string[] = [];
  const close = async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  };
  const gate = {
    configured: hooks.length > 0,
    close,
    async check(files: ReadonlyMap<string, FileContent>, batch = false): Promise<SecurityFinding[]> {
      if (hooks.length === 0) return [];
      try {
        if (dir === undefined) {
          const entries = await listTree(git, tracked);
          checkScratchBudget(entries, budget);
          dir = await mkdtemp(join(tmpdir(), 'capture-security-'));
          scratch = new Git(dir);
          // The same object format, so the same tree has the same id in both repositories.
          await scratch.run(['init', '--quiet', `--object-format=${await git.text(['rev-parse', '--show-object-format'])}`]);
          ({ tree: baseline, linkedSupport } = await reproduceTree(git, tracked, entries, scratch, dir));
        }
        // Restore only our disposable repository, including hook changes from the previous document.
        await scratch.run(['read-tree', '--reset', '-u', baseline]);
        await scratch.run(['clean', '-fdx', '--quiet']);
        const written = new Set<string>();
        for (const [path, content] of files) {
          checkRepoPath(path);
          // Git's pathspecs can match another set's file, even after the option delimiter.
          if (batch && (path.startsWith(':') || /[*?\[]/.test(path))) return [{ hook: SECURITY_ALIAS, line: 1 }];
          // pre-commit and its hooks would read a path that starts with `-` as an option, such as `--config`.
          if (path === PRE_COMMIT_CONFIG || path.startsWith('-')) return [{ hook: SECURITY_ALIAS, line: 1 }];
          // A write through a tracked link would land in its target while the hooks are handed the link, which they
          // skip: a candidate at a link's path, or below one, is never checked, so it is refused.
          if (await throughLink(dir, path)) return [{ hook: SECURITY_ALIAS, line: 1 }];
          await mkdir(dirname(join(dir, path)), { recursive: true });
          await writeFile(join(dir, path), contentBytes(content));
          if (batch) {
            // Distinct Git paths can address the same file on the scratch filesystem.
            const { dev, ino } = await lstat(join(dir, path), { bigint: true });
            const identity = `${dev}:${ino}`;
            if (written.has(identity)) return [{ hook: SECURITY_ALIAS, line: 1 }];
            written.add(identity);
          }
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
            if (batch) return [{ hook: SECURITY_ALIAS, line: 1 }];
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
      } catch (error) {
        // A tracked tree too large to reproduce, or one this file system cannot hold, gives no answer for any
        // document: the run stops with its code. Marking each checked document as rejected would show a security
        // finding the hooks never made, and the run would never settle.
        if (error instanceof SecurityScratchBudgetError || error instanceof SecurityScratchTreeError) {
          // A cleanup failure must not hide the named error; the caller's own close removes what is left.
          await close().catch(() => {});
          throw error;
        }
        // Spawn, filesystem and configuration failures must fail closed without exposing content.
        return [{ hook: SECURITY_ALIAS, line: 1 }];
      }
    },
  };
  if (!config.securityBatchable || !gate.configured) return gate;
  return { ...gate, passesBatch: async (files) => (await gate.check(files, true)).length === 0 };
}

/**
 * Asks the hooks about a document's title before it names a file, an `ids` key or a report line: the title as the
 * text of the file it would name, `path`, so hooks scoped to paths see it where the document would go. The path
 * stays in the disposable repository. Findings on the title carry line 0, which a notice reads as "in the title";
 * null when the gate has no answer, also for a path no gate can take (a tracked folder Git accepts but a repository
 * path may not hold): the error would name the path, and with it the title, before any hook saw it.
 */
export async function checkTitle(gate: SecurityGate, path: string, title: string): Promise<SecurityFinding[] | null> {
  try {
    checkRepoPath(path);
  } catch {
    return null;
  }
  const findings = await gate.check(new Map([[path, `${title.normalize('NFC')}\n`]]));
  return findings === null ? null : findings.map(({ hook }) => ({ hook, line: 0 }));
}

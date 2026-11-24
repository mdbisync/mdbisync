// The `lint` and `fix` commands: Markdown files given as paths (folders are
// searched for `.md` files), checked or rewritten into Linear's form.

import { closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeSync, type Stats } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fixText } from './fix.ts';
import { duplicateTitles, linkedFileCheck, lintText } from './lint.ts';
import { MarkdownLimitError } from './markdown.ts';
import { FIXED_RULES, LINT_RULES, type Finding } from './rules.ts';
import { parseLfsPointer } from '../state/lfs.ts';
import { lineText } from '../run/output.ts';
import { admitsCapturedFile, isCaptureName } from '../sync/upload-type.ts';

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Folders never searched: version control and installed packages. */
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules']);

/** Exit code for a bad command line: an option or a path that does not exist. */
export const USAGE_ERROR = 2;

/**
 * `.md` files under the paths, written relative to the working folder and
 * sorted. Symbolic links are not followed, so a link cannot lead `fix` out
 * of the given tree or into a loop; `runLint` and `runFix` also refuse a path
 * whose folders pass through one (`badPaths`).
 */
export function markdownFiles(paths: readonly string[], cwd: string = process.cwd()): string[] {
  return filesUnder(paths, cwd, (path) => path.endsWith('.md'));
}

/** Regular files under the paths whose file name `accept` takes, as `markdownFiles` finds them. */
function filesUnder(paths: readonly string[], cwd: string, accept: (path: string) => boolean): string[] {
  const found = new Set<string>();
  const walk = (absolute: string): void => {
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (!SKIPPED_FOLDERS.has(name)) walk(join(absolute, name));
      }
    } else if (stat.isFile() && accept(basename(absolute))) {
      found.add(relative(cwd, absolute).split(sep).join('/'));
    }
  };
  for (const path of paths.length > 0 ? paths : ['.']) walk(resolve(cwd, path));
  return [...found].sort();
}

/**
 * Files under the paths named as a capture names an upload whose bytes the
 * upload check now refuses: an earlier, weaker check admitted them. They
 * stay in the repository until a person removes or replaces them.
 */
function refusedUploads(paths: readonly string[], cwd: string): Finding[] {
  return filesUnder(paths, cwd, isCaptureName)
    .filter((file) => {
      const bytes = readFileSync(join(cwd, file));
      // Without its Git LFS object the file's bytes are not here to check.
      return parseLfsPointer(bytes) === null && !admitsCapturedFile(file, bytes);
    })
    .map((file) => ({ file, line: 1, rule: 'upload-file-refused' as const, message: LINT_RULES['upload-file-refused'] }));
}

/**
 * A usage problem in the paths, or undefined: options are not supported,
 * every path must exist, must not be a symbolic link, and must be reached
 * through no symbolic link and spelled with its exact case, as `isFileAt`
 * requires of a linked file. A folder linked elsewhere
 * would otherwise lead `fix` to rewrite a file outside the given tree.
 */
function badPaths(paths: readonly string[], cwd: string): string | undefined {
  const option = paths.find((path) => path.startsWith('-'));
  if (option !== undefined) return `unknown option: ${lineText(option)}`;
  const missing = paths.find((path) => !existsSync(resolve(cwd, path)));
  if (missing !== undefined) return `no such file or folder: ${lineText(missing)}`;
  const linked = paths.find((path) => {
    const absolute = resolve(cwd, path);
    return lstatSync(absolute).isSymbolicLink() || !isOwnPath(cwd, relative(cwd, absolute));
  });
  return linked === undefined ? undefined : `path passes through a symbolic link or differs in case: ${lineText(linked)}`;
}

function lintAll(files: readonly string[], cwd: string): Finding[] {
  const findings = files.flatMap((file) => lintText(file, readFileSync(join(cwd, file), 'utf8'), { linkedFileExists: linkedFileResolver(file, cwd) }));
  return [...findings, ...duplicateTitles(files)];
}

function describe(findings: readonly Finding[]): string {
  return findings.map((finding) => `${lineText(finding.file)}:${finding.line}: ${finding.rule}: ${lineText(finding.message)}\n`).join('');
}

/**
 * The existence check for `lint` and `fix` on `file`, a path relative to `root` (the
 * repository's top folder, where the hook runs): a link resolves as the
 * sync resolves it, and must name a file there.
 */
export function linkedFileResolver(file: string, root: string): (url: string) => boolean {
  return linkedFileCheck(file.split(sep).join('/'), (path) => isFileAt(root, path));
}

/**
 * Whether a regular file is at `path` under `root`, as the repository would
 * store it: reached through no symbolic link, and spelled with the exact case
 * of its name. A path the file system cannot hold (a NUL byte) names none.
 */
function isFileAt(root: string, path: string): boolean {
  try {
    return statSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true && isOwnPath(root, path);
  } catch {
    return false;
  }
}

/** Whether `path` under `root` is reached through no symbolic link and spelled with the exact case of its names. */
function isOwnPath(root: string, path: string): boolean {
  try {
    return realpathSync.native(join(root, path)) === join(realpathSync.native(root), path);
  } catch {
    return false;
  }
}

/** The file in Linear's form, or undefined when rewriting it takes it over the Markdown limits. */
function fixedText(file: string, text: string, cwd: string): string | undefined {
  try {
    return fixText(text, { linkedFileExists: linkedFileResolver(file, cwd) });
  } catch (error) {
    if (error instanceof MarkdownLimitError) return undefined;
    throw error;
  }
}

/** The finding for a file that lint passes but `fix` cannot rewrite within the Markdown limits. */
function complexity(file: string): Finding {
  return { file, line: 1, rule: 'markdown-complexity', message: LINT_RULES['markdown-complexity'] };
}

/** `lint`: exit 1 and one line per finding when Linear would lose or alter something, or a file is not in Linear's form. */
export function runLint(paths: readonly string[], cwd: string = process.cwd()): CommandResult {
  return withEscapedErrors(() => lint(paths, cwd));
}

function lint(paths: readonly string[], cwd: string): CommandResult {
  const problem = badPaths(paths, cwd);
  if (problem !== undefined) return { exitCode: USAGE_ERROR, stdout: '', stderr: `${problem}\n` };
  const files = markdownFiles(paths, cwd);
  const findings = [...lintAll(files, cwd), ...refusedUploads(paths, cwd)];
  const failing = new Set(findings.map((finding) => finding.file)); // duplicate titles included
  const unfixed = files.filter((file) => {
    if (failing.has(file)) return false;
    const text = readFileSync(join(cwd, file), 'utf8');
    const fixed = fixedText(file, text, cwd);
    if (fixed === undefined) findings.push(complexity(file));
    return fixed !== undefined && fixed !== text;
  });
  const stdout = describe(findings) + unfixed.map((file) => `${lineText(file)}: not in Linear's form; run fix\n`).join('');
  return { exitCode: stdout === '' ? 0 : 1, stdout, stderr: '' };
}

/** `fix`: rewrites files into Linear's form; exit 1 when a file changed or lint found a problem `fix` leaves to the author. */
export function runFix(paths: readonly string[], cwd: string = process.cwd()): CommandResult {
  return withEscapedErrors(() => fix(paths, cwd));
}

function fix(paths: readonly string[], cwd: string): CommandResult {
  const problem = badPaths(paths, cwd);
  if (problem !== undefined) return { exitCode: USAGE_ERROR, stdout: '', stderr: `${problem}\n` };
  const files = markdownFiles(paths, cwd);
  // A file with a lint finding, a colliding title included, is left as it is:
  // its author decides. Only the findings `fix` writes in Linear's form do not stop it.
  const before = [...lintAll(files, cwd), ...refusedUploads(paths, cwd)];
  const failing = new Set(before.filter((finding) => !FIXED_RULES.has(finding.rule)).map((finding) => finding.file));
  const changed: string[] = [];
  const moved: string[] = [];
  for (const file of files) {
    if (failing.has(file)) continue;
    const outcome = fixFile(file, cwd);
    if (outcome === 'complex') before.push(complexity(file));
    else if (outcome === 'moved') moved.push(file);
    else if (outcome === 'fixed') changed.push(file);
  }
  // The rewritten files are linted again: their earlier findings were only
  // ones `fix` writes in Linear's form, and what is left of them is reported.
  const rewritten = new Set(changed);
  const findings = [...before.filter((finding) => !rewritten.has(finding.file)), ...lintAll(changed, cwd)];
  const stdout = changed.map((file) => `${lineText(file)}: fixed\n`).join('')
    + moved.map((file) => `${lineText(file)}: moved while fix ran; left unchanged\n`).join('')
    + describe(findings);
  return { exitCode: stdout === '' ? 0 : 1, stdout, stderr: '' };
}

/**
 * Runs a command, rethrowing an error with its message escaped as `lineText`
 * does: a file system error names the file, whose name may hold controls.
 */
function withEscapedErrors(command: () => CommandResult): CommandResult {
  try {
    return command();
  } catch (error) {
    if (error instanceof Error) throw new Error(lineText(error.message), { cause: error });
    throw error;
  }
}

/**
 * Rewrites `file` into Linear's form. It is read through a descriptor opened
 * without following a link in the last name, used only while it still holds
 * the regular file at `file`'s own path under `cwd` (the same device and
 * inode, reached through no link, and where the system names the
 * descriptor's own path, that path), and written through a second such
 * descriptor that must hold the same file. A folder or file swapped for a
 * link after the search cannot redirect the write; such a file is 'moved'.
 * A file that needs no change is only read, so it may be read-only.
 */
function fixFile(file: string, cwd: string): 'fixed' | 'unchanged' | 'complex' | 'moved' {
  const path = join(cwd, file);
  const reader = openOwnFile(path, constants.O_RDONLY);
  if (reader === undefined) return 'moved';
  let opened: Stats;
  let text: string;
  try {
    opened = fstatSync(reader);
    const named = statSync(path, { throwIfNoEntry: false });
    if (!opened.isFile() || !sameFile(named, opened) || !isOwnPath(cwd, file) || !holdsOwnPath(reader, cwd, file)) return 'moved';
    text = readFileSync(reader, 'utf8');
  } finally {
    closeSync(reader);
  }
  const fixed = fixedText(file, text, cwd);
  if (fixed === undefined) return 'complex';
  if (fixed === text) return 'unchanged';
  const writer = openOwnFile(path, constants.O_WRONLY);
  if (writer === undefined) return 'moved';
  try {
    if (!sameFile(fstatSync(writer), opened)) return 'moved';
    const bytes = Buffer.from(fixed, 'utf8');
    ftruncateSync(writer, 0);
    for (let written = 0; written < bytes.length;) written += writeSync(writer, bytes, written, bytes.length - written, written);
    return 'fixed';
  } finally {
    closeSync(writer);
  }
}

/** A descriptor for `path` opened with `flags` and without following a link in its last name, or undefined when no file is there any more or a link is. */
function openOwnFile(path: string, flags: number): number | undefined {
  try {
    return openSync(path, flags | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/**
 * Whether the descriptor holds `file` under `cwd`, by the path the system
 * keeps for it (`/proc/self/fd` on Linux). Unlike a check by name, this
 * cannot be passed by a folder swapped between the open and the check.
 * Without such a path the name checks in `fixFile` stand alone.
 */
function holdsOwnPath(fd: number, cwd: string, file: string): boolean {
  let held: string;
  try {
    held = readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return true;
  }
  return held === join(realpathSync.native(cwd), file);
}

function sameFile(a: Stats | undefined, b: Stats): boolean {
  return a !== undefined && a.dev === b.dev && a.ino === b.ino;
}

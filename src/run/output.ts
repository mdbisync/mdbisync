// Validation at report and tooling output boundaries. Text may contain
// Unicode Markdown and normal whitespace, but not binary control characters.
import { randomUUID } from 'node:crypto';
import { type Stats, constants } from 'node:fs';
import { lstat, mkdir, open, readlink, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { message } from '../messages.ts';

export function outputText(value: unknown, limit = 16 * 1024 * 1024): string {
  if (typeof value !== 'string' || value.length > limit || !/^[\t\n\r\x20-\x7e -\u{10ffff}]*$/u.test(value)) {
    throw new Error(message('output.invalid-text', { limit }));
  }
  return value;
}

/** A character written out as its `\uXXXX` escape. */
function escapedControl(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

/** Display controls explicitly without losing the result of a completed run. */
export function reportText(value: string, limit = 16 * 1024 * 1024): string {
  return outputText(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, escapedControl), limit);
}

/**
 * A value printed inside one line of output, such as a file name: every C0
 * and C1 control and DEL escaped, tabs and line breaks included, so the value
 * cannot start a new line or drive the terminal. A backslash is escaped too,
 * so a name holding the text of an escape prints apart from one holding the
 * character.
 */
export function lineText(value: string): string {
  return value.replace(/[\u0000-\u001f\u005c\u007f-\u009f]/g, escapedControl);
}

export function outputCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(message('output.invalid-count'));
  return Number(value);
}

/** Resolve a locally chosen file name within its configured output directory. */
export function outputFile(directory: string, name: string): string {
  const base = resolve(directory);
  const file = resolve(base, name);
  if (file === base || !inside(base, file)) throw new Error(message('output.outside-directory'));
  return file;
}

/** The most symbolic links one report path may pass through, as on Linux. */
const MAX_LINKS = 40;

/**
 * Write a report file without following a symbolic link the checkout holds.
 * A repository can commit a link where the operator's report path points, so
 * the path is resolved here one name at a time, following each link by hand:
 * a link inside the checkout is refused wherever the path meets it, also
 * behind a link outside the checkout (links outside it, such as a system's
 * `/tmp`, are the runner's own), and `..` goes up from where the path really
 * is. Missing directories are made one at a time. The text goes to a new
 * temporary file opened with `O_EXCL | O_NOFOLLOW` and is renamed onto the
 * name: a link already there is replaced, never written through, and a
 * regular file there keeps its mode.
 *
 * Only what the checkout holds when the run writes is in scope: a process
 * that swaps a directory for a link while this runs is not.
 *
 * @param path relative to the working directory, as the file system takes it
 * @param checkout the repository's working tree
 */
export async function writeReportFile(path: string, text: string, checkout: string): Promise<void> {
  const [root, names] = rootAndNames(isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`);
  const name = names.pop();
  if (name === undefined || name === '.' || name === '..') throw new Error(message('output.not-a-file', { path }));
  const file = join(await reportDirectory(root, names, await realpath(checkout), path), name);
  const existing = await lstat(file).catch(ifMissing);
  if (existing !== undefined && !existing.isFile() && !existing.isSymbolicLink()) throw new Error(message('output.not-a-file', { path }));
  const kept = existing?.isFile() === true ? existing.mode & 0o7777 : undefined;
  const temporary = join(dirname(file), `.mdbisync-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, kept === undefined ? 0o666 : 0o600);
  try {
    await handle.writeFile(text);
    if (kept !== undefined) await handle.chmod(kept);
    await handle.close();
    await rename(temporary, file);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Windows takes both slashes between names; elsewhere a backslash is part of a name. */
const SEPARATORS = sep === '\\' ? /[\\/]/ : /\//;

/** An absolute path's root (`/`, or a drive such as `C:\`) and the names after it. */
function rootAndNames(path: string): [string, string[]] {
  const { root } = parse(path);
  return [root, path.slice(root.length).split(SEPARATORS).filter((name) => name !== '')];
}

/** The real directory that `names`, read from `root`, lead to; missing ones are made. */
async function reportDirectory(root: string, names: readonly string[], checkout: string, path: string): Promise<string> {
  const pending = [...names];
  // `current` never holds a link: each link met is replaced by its target's names.
  let current = root;
  let links = 0;
  while (pending.length > 0) {
    const name = pending.shift() as string;
    if (name === '.') continue;
    if (name === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, name);
    let entry: Stats | undefined = await lstat(next).catch(ifMissing);
    if (entry === undefined) {
      await mkdir(next).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
      entry = await lstat(next);
    }
    if (!entry.isSymbolicLink()) {
      current = next;
      continue;
    }
    if (inside(checkout, current)) throw new Error(message('output.linked-directory', { path: next }));
    if (++links > MAX_LINKS) throw new Error(message('output.link-loop', { path }));
    const target = await readlink(next);
    if (isAbsolute(target)) {
      const [targetRoot, targetNames] = rootAndNames(target);
      current = targetRoot;
      pending.unshift(...targetNames);
    } else {
      pending.unshift(...rootAndNames(target)[1]);
    }
  }
  return current;
}

function inside(base: string, path: string): boolean {
  const rest = relative(base, path);
  return rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

function ifMissing(error: NodeJS.ErrnoException): undefined {
  if (error.code === 'ENOENT') return undefined;
  throw error;
}

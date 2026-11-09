// The `lint` and `fix` commands: Markdown files given as paths (folders are
// searched for `.md` files), checked or rewritten into Linear's form.

import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fixText } from './fix.ts';
import { duplicateTitles, lintText } from './lint.ts';
import type { Finding } from './rules.ts';

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
 * of the given tree or into a loop.
 */
export function markdownFiles(paths: readonly string[], cwd: string = process.cwd()): string[] {
  const found = new Set<string>();
  const walk = (absolute: string): void => {
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (!SKIPPED_FOLDERS.has(name)) walk(join(absolute, name));
      }
    } else if (stat.isFile() && absolute.endsWith('.md')) {
      found.add(relative(cwd, absolute).split(sep).join('/'));
    }
  };
  for (const path of paths.length > 0 ? paths : ['.']) walk(resolve(cwd, path));
  return [...found].sort();
}

/** A usage problem in the paths, or undefined: options are not supported, every path must exist. */
function badPaths(paths: readonly string[], cwd: string): string | undefined {
  const option = paths.find((path) => path.startsWith('-'));
  if (option !== undefined) return `unknown option: ${option}`;
  const missing = paths.find((path) => !existsSync(resolve(cwd, path)));
  return missing === undefined ? undefined : `no such file or folder: ${missing}`;
}

function lintAll(files: readonly string[], cwd: string): Finding[] {
  const findings = files.flatMap((file) => lintText(file, readFileSync(join(cwd, file), 'utf8')));
  return [...findings, ...duplicateTitles(files)];
}

function describe(findings: readonly Finding[]): string {
  return findings.map((finding) => `${finding.file}:${finding.line}: ${finding.rule}: ${finding.message}\n`).join('');
}

/**
 * Whether the file a relative link in `file` points to exists, for `fix`.
 * A destination that cannot be decoded or starts at the root is taken to
 * exist, as without the check.
 */
export function linkedFileResolver(file: string): (url: string) => boolean {
  return (url) => {
    const target = url.split(/[?#]/)[0]!;
    if (target.startsWith('/')) return true;
    try {
      return existsSync(join(dirname(file), decodeURIComponent(target)));
    } catch {
      return true;
    }
  };
}

/** `lint`: exit 1 and one line per finding when Linear would lose or alter something, or a file is not in Linear's form. */
export function runLint(paths: readonly string[], cwd: string = process.cwd()): CommandResult {
  const problem = badPaths(paths, cwd);
  if (problem !== undefined) return { exitCode: USAGE_ERROR, stdout: '', stderr: `${problem}\n` };
  const files = markdownFiles(paths, cwd);
  const findings = lintAll(files, cwd);
  const failing = new Set(findings.map((finding) => finding.file)); // duplicate titles included
  const unfixed = files.filter((file) => {
    if (failing.has(file)) return false;
    const path = join(cwd, file);
    const text = readFileSync(path, 'utf8');
    return fixText(text, { linkedFileExists: linkedFileResolver(path) }) !== text;
  });
  const stdout = describe(findings) + unfixed.map((file) => `${file}: not in Linear's form; run fix\n`).join('');
  return { exitCode: stdout === '' ? 0 : 1, stdout, stderr: '' };
}

/** `fix`: rewrites files into Linear's form; exit 1 when a file changed or lint found a problem `fix` leaves to the author. */
export function runFix(paths: readonly string[], cwd: string = process.cwd()): CommandResult {
  const problem = badPaths(paths, cwd);
  if (problem !== undefined) return { exitCode: USAGE_ERROR, stdout: '', stderr: `${problem}\n` };
  const files = markdownFiles(paths, cwd);
  // A file whose title collides with another's is a lint finding too: leave it as it is.
  const colliding = new Set(duplicateTitles(files).map((finding) => finding.file));
  const changed: string[] = [];
  for (const file of files) {
    if (colliding.has(file)) continue;
    const path = join(cwd, file);
    const text = readFileSync(path, 'utf8');
    const fixed = fixText(text, { linkedFileExists: linkedFileResolver(path) });
    if (fixed !== text) {
      writeFileSync(path, fixed);
      changed.push(file);
    }
  }
  const findings = lintAll(files, cwd);
  const stdout = changed.map((file) => `${file}: fixed\n`).join('') + describe(findings);
  return { exitCode: stdout === '' ? 0 : 1, stdout, stderr: '' };
}

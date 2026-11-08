// The `lint` and `fix` commands: Markdown files given as paths (folders are
// searched for `.md` files), checked or rewritten into Linear's form.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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

/** `.md` files under the paths, as written relative to the working folder, sorted. */
export function markdownFiles(paths: readonly string[], cwd: string = process.cwd()): string[] {
  const found = new Set<string>();
  const walk = (path: string): void => {
    const stat = statSync(join(cwd, path));
    if (stat.isDirectory()) {
      for (const name of readdirSync(join(cwd, path))) {
        if (!SKIPPED_FOLDERS.has(name)) walk(path === '.' ? name : `${path}/${name}`);
      }
    } else if (path.endsWith('.md')) {
      found.add(relative(cwd, join(cwd, path)).split(sep).join('/'));
    }
  };
  for (const path of paths.length > 0 ? paths : ['.']) walk(path);
  return [...found].sort();
}

function lintAll(files: readonly string[], cwd: string): Finding[] {
  const findings = files.flatMap((file) => lintText(file, readFileSync(join(cwd, file), 'utf8')));
  return [...findings, ...duplicateTitles(files)];
}

function describe(findings: readonly Finding[]): string {
  return findings.map((finding) => `${finding.file}:${finding.line}: ${finding.rule}: ${finding.message}\n`).join('');
}

/** `lint`: exit 1 and one line per finding when Linear would lose or alter something, or a file is not in Linear's form. */
export function runLint(paths: readonly string[], cwd: string = process.cwd()): CommandResult {
  const files = markdownFiles(paths, cwd);
  const findings = lintAll(files, cwd);
  const failing = new Set(findings.map((finding) => finding.file));
  const unfixed = files.filter((file) => {
    if (failing.has(file)) return false;
    const text = readFileSync(join(cwd, file), 'utf8');
    return fixText(text) !== text;
  });
  const stdout = describe(findings) + unfixed.map((file) => `${file}: not in Linear's form; run fix\n`).join('');
  return { exitCode: stdout === '' ? 0 : 1, stdout, stderr: '' };
}

/** `fix`: rewrites files into Linear's form; exit 1 when a file changed or lint found a problem `fix` leaves to the author. */
export function runFix(paths: readonly string[], cwd: string = process.cwd()): CommandResult {
  const files = markdownFiles(paths, cwd);
  const changed: string[] = [];
  for (const file of files) {
    const path = join(cwd, file);
    const text = readFileSync(path, 'utf8');
    const fixed = fixText(text);
    if (fixed !== text) {
      writeFileSync(path, fixed);
      changed.push(file);
    }
  }
  const findings = lintAll(files, cwd);
  const stdout = changed.map((file) => `${file}: fixed\n`).join('') + describe(findings);
  return { exitCode: stdout === '' ? 0 : 1, stdout, stderr: '' };
}

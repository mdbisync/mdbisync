// Offline inputs of the format scenarios (L0): the fixture bank and the
// corpus, generated in memory from the default seed, as files the `lint` and
// `fix` commands run on, with what each file should become.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildCorpus } from '../../corpus/generate.ts';
import { BANK_HOME } from '../../corpus/tree.ts';
import { BANK_DIR, goldenMarkdownPath, loadBank, readFixture, readOptional } from '../../probe/bank.ts';
import { MARKERS } from './conflicts.ts';
import { REPO_ROOT, engineEntry } from './engine.ts';

export interface OfflineInput {
  /** Path → text. */
  files: Map<string, string>;
  /** Path → the form Linear keeps, for the files whose form is recorded (null: not recorded). */
  golden: Map<string, string>;
  /** Files the linter must leave out. */
  lintErrors: string[];
}

function bankInput(filter: (fixture: { class: string; construct: string }, text: string) => boolean): OfflineInput {
  const bank = loadBank(join(REPO_ROOT, BANK_DIR));
  const input: OfflineInput = { files: new Map(), golden: new Map(), lintErrors: [] };
  for (const fixture of bank.fixtures) {
    if (fixture.synced === false || !fixture.file.endsWith('.md')) continue;
    const text = readFixture(bank, fixture);
    if (!filter(fixture, text)) continue;
    input.files.set(fixture.file, text);
    if (fixture.class === 'lint-error') input.lintErrors.push(fixture.file);
    const golden = readOptional(join(bank.dir, goldenMarkdownPath(fixture.file)));
    if (golden !== undefined) input.golden.set(fixture.file, golden);
    else if (fixture.class === 'unchanged') input.golden.set(fixture.file, text);
  }
  input.lintErrors.sort();
  return input;
}

function corpusInput(): OfflineInput {
  // The hook revision only fills the corpus's .pre-commit-config.yaml, which the format scenarios do not read.
  const corpus = buildCorpus('0'.repeat(40));
  const bank = loadBank(join(REPO_ROOT, BANK_DIR));
  // A bank fixture's recorded form holds for its corpus copy only while the copy is the same text
  // (copying rewrites links that lead out of the bank, and the form recorded for the old link no longer applies).
  const bankGolden = new Map(bank.fixtures.map((fixture) => [fixture.file, { text: readFixture(bank, fixture), golden: readOptional(join(bank.dir, goldenMarkdownPath(fixture.file))) }]));
  const input: OfflineInput = { files: new Map(), golden: new Map(), lintErrors: [] };
  for (const file of corpus.files) {
    if (file.kind !== 'markdown' || !file.synced) continue;
    const text = file.content.toString('utf8');
    input.files.set(file.path, text);
    if (file.expected === 'lint-error') {
      // The fixer leaves these as they are; they have no form to reach.
      input.lintErrors.push(file.path);
      continue;
    }
    // A copied bank fixture has its recorded Linear form; an unchanged document is its own form.
    const fromBank = file.path.startsWith(`${BANK_HOME}/`) ? bankGolden.get(file.path.slice(BANK_HOME.length + 1)) : undefined;
    if (fromBank?.golden !== undefined) {
      if (fromBank.text === text) input.golden.set(file.path, fromBank.golden);
    } else if (file.expected === 'unchanged') input.golden.set(file.path, text);
  }
  input.lintErrors.sort();
  return input;
}

/** A bank fixture the Linear-format hook fixes (class `fixable`): its file name and text. */
export function fixableSample(): { file: string; text: string } {
  const bank = loadBank(join(REPO_ROOT, BANK_DIR));
  const fixture = bank.fixtures.find((candidate) => candidate.class === 'fixable' && candidate.synced !== false && candidate.file.endsWith('.md'));
  if (fixture === undefined) throw new Error('the fixture bank has no fixable fixture');
  return { file: fixture.file, text: readFixture(bank, fixture) };
}

/** Documents with conflict markers in a paragraph, a list, a table and a code block (L0-04). */
function markerInput(): OfflineInput {
  const set = `${MARKERS.git}\n\nOne version.\n\n${MARKERS.linear}\n\nThe other version.\n\n${MARKERS.end}`;
  const files = new Map([
    ['markers/paragraph.md', `# Notes\n\nBefore.\n\n${set}\n\nAfter.\n`],
    ['markers/list.md', `# Notes\n\n- First\n\n${set}\n\n- Last\n`],
    ['markers/table.md', `# Notes\n\n${MARKERS.git}\n\n| a | b |\n| -- | -- |\n| 1 | 2 |\n\n${MARKERS.linear}\n\n| a | b |\n| -- | -- |\n| 3 | 4 |\n\n${MARKERS.end}\n`],
    ['markers/code.md', `# Notes\n\n${MARKERS.git}\n\n\`\`\`text\none\n\`\`\`\n\n${MARKERS.linear}\n\n\`\`\`text\ntwo\n\`\`\`\n\n${MARKERS.end}\n`],
  ]);
  return { files, golden: new Map(), lintErrors: [] };
}

export function offlineInput(name: unknown): OfflineInput {
  switch (name) {
    case 'bank':
      return bankInput((fixture) => fixture.class !== 'lint-error');
    case 'lint-errors':
      return bankInput((fixture) => fixture.class === 'lint-error');
    case 'conflict-markers':
      return markerInput();
    case 'full':
    case 'fixtures-and-corpus':
      return corpusInput();
    default:
      throw new Error(`unknown offline input ${String(name)}`);
  }
}

export function writeInput(dir: string, files: ReadonlyMap<string, string>): void {
  rmSync(dir, { recursive: true, force: true });
  for (const [path, text] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

export function readInput(dir: string, paths: Iterable<string>): Map<string, string> {
  return new Map([...paths].map((path) => [path, readFileSync(join(dir, path), 'utf8')]));
}

/**
 * What of a fixed file reaches Linear: the text without its front matter
 * (front matter stays in git) and the blank line after it.
 */
export function linearPart(text: string): string {
  return text.replace(/^(?:﻿)?---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)(?:\r?\n)?/, '');
}

/** Runs the command line's `lint` or `fix` on a folder. */
export function runFormatCommand(command: 'lint' | 'fix', dir: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [engineEntry(), command, '.'], { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error !== undefined) throw new Error(`could not run ${command}: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export const hashes = (files: ReadonlyMap<string, string>) => new Map([...files].map(([path, text]) => [path, createHash('sha256').update(text).digest('hex')]));

/** The marker lines of each file, in order. */
export const markerLines = (files: ReadonlyMap<string, string>) =>
  new Map([...files].map(([path, text]) => [path, text.split('\n').filter((line) => (Object.values(MARKERS) as string[]).includes(line))]));

/** Findings of `lint` output (`file:line: rule: message`). */
export function parseFindings(stdout: string): Array<{ file: string; line: number; rule: string; message: string }> {
  return stdout.split('\n').flatMap((text) => {
    const match = /^(.+?):(\d+): ([a-z][a-z0-9-]*): (.+)$/.exec(text);
    return match === null ? [] : [{ file: match[1] as string, line: Number(match[2]), rule: match[3] as string, message: match[4] as string }];
  });
}

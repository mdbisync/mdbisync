// The troubleshooting page against the code: every code a run can report
// and every error or ending message the code can print is on the page, so
// a new message cannot ship without its explanation.
//
// The test reads the sources instead of a hand-kept list:
//
// - Codes: the kebab-case literals given to a `code` or `rule` field or
//   compared with one, the members of the code types below, the rules
//   passed to the functions that leave files out, the setup check names and
//   the lint rule names. Each must appear on the page in backticks.
// - Messages: every string or template literal that builds an error, a
//   run's last line or a setup check's detail: `new …Error(…)`, `super(…)`
//   in an error class, `failed(…)` and a warning's `detail:`, a `message:`
//   next to a code, kind or rule, a returned `<command>: …` line, and what
//   the command line and the action write out, read up to the line where
//   the call's parentheses close. Each fixed part of ten letters or more,
//   and the longest part of each literal, must appear on the page, with the
//   `${…}` parts left out.
//
// Out of scope: `src/release/` builds releases and is never run by users,
// `src/test-hooks.ts` acts only in tests, and `src/format/` (`lint` and
// `fix`) has its own page, `docs/linear-format.md`, with its own test.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LINT_RULES } from '../../src/format/rules.ts';
import { CHECK_NAMES } from '../../src/setup/report.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PAGE = readFileSync(join(ROOT, 'docs/troubleshooting.md'), 'utf8');
const OUT_OF_SCOPE = ['src/release/', 'src/format/', 'src/test-hooks.ts'];

/** The code types whose members a run reports. */
const CODE_TYPES = ['FailureCode', 'SkipReason', 'StructuralCode', 'UnsyncedReason', 'AnnotationProblemKind', 'PartialCode'];

interface Source {
  path: string;
  text: string;
}

function sources(): Source[] {
  const found: Source[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.includes('test-helpers')) found.push({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') });
    }
  };
  walk(join(ROOT, 'src'));
  return found.filter((source) => !OUT_OF_SCOPE.some((folder) => source.path.startsWith(folder)));
}

const CODE_LITERAL = /'([a-z][a-z0-9]*(?:-[a-z0-9]+)*)'/g;

/** Kebab-case codes, each with a file that names it. */
function collectCodes(files: Source[]): Map<string, string> {
  const codes = new Map<string, string>();
  const add = (code: string, path: string) => { if (!codes.has(code)) codes.set(code, path); };
  // Constants given to a rule field by name, such as `rule: UPLOAD_TOO_LARGE`.
  const constants = new Map<string, string>();
  for (const { text } of files) for (const match of text.matchAll(/export const ([A-Z][A-Z0-9_]*) = '([a-z][a-z0-9-]*)'/g)) constants.set(match[1]!, match[2]!);
  const positions = [
    /(?<!typeof )\b(?:code|rule)\??\s*(?::|===|!==)\s*(?:'[a-z0-9-]+'(?:\s*\|\s*'[a-z0-9-]+')*|[A-Z][A-Z0-9_]*\b)/g,
    /\b(?:leaveOut|keepTracked)\([^;]*;/g,
    /\brules\.push\([^;]*;/g,
    new RegExp(`\\btype (?:${CODE_TYPES.join('|')})\\s*=([^;]+);`, 'g'),
  ];
  for (const { path, text } of files) {
    for (const position of positions) {
      for (const match of text.matchAll(position)) {
        // An indexed access such as `Outcome['captured']` names a field, not a code.
        for (const literal of match[0].replace(/\['[^']*'\]/g, '').matchAll(CODE_LITERAL)) add(literal[1]!, path);
        const constant = /:\s*([A-Z][A-Z0-9_]*)$/.exec(match[0])?.[1];
        if (constant !== undefined && constants.has(constant)) add(constants.get(constant)!, path);
      }
    }
  }
  for (const name of CHECK_NAMES) add(name, 'src/setup/report.ts');
  for (const rule of Object.keys(LINT_RULES)) add(rule, 'src/format/rules.ts');
  return codes;
}

/** Where a message a person reads starts: an error, a run's last line, a setup check's detail. */
const MESSAGE_SITES = [
  /\bnew [A-Za-z]*Error\(/,
  /\bsuper\(/,
  /\breturn `\$\{[\w.]+\}: /,
  /\bstderr\.write\(/,
  /\bcore\.(?:setFailed|warning)\(/,
  /\.warn\(`/,
  /\bconst problem = /,
  /\bconst given = /,
  // A setup check that fails or warns: its detail ends the run's last line or fills its summary row.
  /\bfailed\(\s*(?:'|$)/,
  /\bstate: 'warning', detail: /,
];

/** The most lines a message call may span. */
const CALL_LINES = 12;

/** The fixed parts of the message literals, each with a file that prints it. */
function collectMessages(files: Source[]): Map<string, string> {
  const messages = new Map<string, string>();
  const words = (part: string) => part.replace(/\s+/g, ' ').trim();
  const letters = (part: string) => part.replace(/[^A-Za-z]/g, '').length;
  const add = (literal: string[], path: string) => {
    const parts = literal.map(words).filter((part) => part.includes(' '));
    // Every long fixed part, and the longest one even when interpolations cut the message into short pieces.
    const longest = parts.reduce<string | undefined>((best, part) => (best === undefined || letters(part) > letters(best) ? part : best), undefined);
    for (const part of parts) {
      if ((letters(part) >= 10 || (part === longest && letters(part) >= 5)) && !messages.has(part)) messages.set(part, path);
    }
  };
  for (const { path, text } of files) {
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      // The command line's error output: the first literal after `stderr:`, not the normal output beside it.
      const stderr = /\bstderr:\s*(.*)$/.exec(line)?.[1];
      if (stderr !== undefined) add(scan(stderr).literals[0] ?? [], path);
      const nearby = lines.slice(Math.max(0, index - 2), index + 1).join('\n');
      const site = MESSAGE_SITES.map((pattern) => pattern.exec(line)).find((match) => match !== null);
      const isMessage = site !== undefined || (/\bmessage:\s*['`]/.test(line) && /\b(?:code|kind|rule):/.test(nearby));
      if (!isMessage) return;
      // From the site on, up to the line where its parentheses close: a call may spread its arguments over lines.
      let call = line.slice(site?.index ?? 0);
      for (let next = index + 1; next < Math.min(lines.length, index + CALL_LINES) && !balanced(call); next++) call += `\n${lines[next]}`;
      for (const literal of scan(call).literals) add(literal, path);
    });
  }
  return messages;
}

/** Whether the code outside the literals closes as many parentheses as it opens. */
function balanced(text: string): boolean {
  const { code } = scan(text);
  return [...code].filter((char) => char === '(').length <= [...code].filter((char) => char === ')').length;
}

/**
 * The string and template literals of a text, in order, each as its fixed
 * parts (a template's `${…}` parts, nested literals included, split it),
 * and the code outside them. An escaped line break counts as a space;
 * a `//` comment runs to the end of its line.
 */
function scan(text: string): { literals: string[][]; code: string } {
  const found: string[][] = [];
  let code = '';
  let at = 0;
  // Reads the literal that opens at `at`, moving past it.
  const read = (): string[] => {
    const quote = text[at++]!;
    const parts: string[] = [];
    let part = '';
    while (at < text.length && text[at] !== quote && (quote === '`' || text[at] !== '\n')) {
      if (text[at] === '\\') {
        const escaped = text[at + 1] ?? '';
        part += escaped === 'n' ? ' ' : escaped;
        at += 2;
      } else if (quote === '`' && text.startsWith('${', at)) {
        at += 2;
        skipExpression();
        parts.push(part);
        part = '';
      } else {
        part += text[at++];
      }
    }
    at++;
    parts.push(part);
    return parts;
  };
  // Moves past the rest of a `${…}` expression and the literals inside it.
  const skipExpression = (): void => {
    let depth = 1;
    while (at < text.length && depth > 0) {
      const char = text[at]!;
      if (char === "'" || char === '"' || char === '`') {
        read();
        continue;
      }
      if (char === '{') depth++;
      if (char === '}') depth--;
      at++;
    }
  };
  while (at < text.length) {
    const char = text[at]!;
    if (char === "'" || char === '"' || char === '`') found.push(read());
    else if (text.startsWith('//', at)) {
      const end = text.indexOf('\n', at);
      at = end === -1 ? text.length : end;
    } else code += text[at++];
  }
  return { literals: found, code };
}

const page = PAGE.replace(/\s+/g, ' ');
const files = sources();

describe('troubleshooting page', () => {
  it('names every code a run can report', () => {
    const missing = [...collectCodes(files)].filter(([code]) => !PAGE.includes(`\`${code}\``));
    assert.deepEqual(missing.map(([code, path]) => `${code} (${path})`), [], 'codes missing from docs/troubleshooting.md');
  });

  it('gives every error and ending message the code can print', () => {
    const missing = [...collectMessages(files)].filter(([message]) => !page.includes(message));
    assert.deepEqual(missing.map(([message, path]) => `${message} (${path})`), [], 'messages missing from docs/troubleshooting.md');
  });

  it('finds the codes and messages of each kind it looks for', () => {
    // Guards the collectors: a refactor that hides a kind of code or message from them fails here, not silently.
    const codes = collectCodes(files);
    for (const code of ['missing-permission', 'removal-held', 'merge-blocked', 'linear-content-too-large-to-write-back', 'upload-too-large', 'front-matter-boundary', 'title-too-long', 'edit-wins-delete', 'stored-in-lfs', 'nested-team', 'linear-format-hook', 'footnote']) {
      assert.ok(codes.has(code), `the code collector misses ${code}`);
    }
    const messages = [...collectMessages(files).keys()];
    for (const message of ['run init at the repository root', 'is not a valid remote name', 'request to Linear failed (', 'setup error (', 'stopped by Linear before any write', 'missing command', 'could not be revoked:', 'does not exist: run initial sync first.', 'the Linear app saw no team in two lookups', 'merge commits are not allowed', 'git object', 'must be one of']) {
      assert.ok(messages.some((found) => found.includes(message)), `the message collector misses "${message}"`);
    }
    assert.ok(!codes.has('stale') && !messages.includes('Capture Linear changes'), 'the collectors take internal values for messages');
  });
});

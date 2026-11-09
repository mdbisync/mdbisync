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
// - Messages: every string or template literal that builds an error or a
//   run's last line: `new …Error(…)`, `super(…)` in an error class, a
//   `message:` next to a code, kind or rule, a returned `<command>: …`
//   line, and what the command line and the action write out. Each
//   fixed part of ten letters or more must appear on the page, with the
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

/** Lines that build an error or a message a person reads. */
const MESSAGE_SITES = [
  /\bnew [A-Za-z]*Error\(/,
  /\bsuper\(/,
  /\breturn `\$\{[\w.]+\}: /,
  /\bstderr\.write\(/,
  /\bcore\.(?:setFailed|warning)\(/,
  /\.warn\(`/,
  /\bconst problem = /,
];

/** The fixed parts of the message literals, each with a file that prints it. */
function collectMessages(files: Source[]): Map<string, string> {
  const messages = new Map<string, string>();
  const add = (parts: string[], path: string) => {
    for (const part of parts) {
      const fixed = part.replace(/\s+/g, ' ').trim();
      if (fixed.includes(' ') && fixed.replace(/[^A-Za-z]/g, '').length >= 10 && !messages.has(fixed)) messages.set(fixed, path);
    }
  };
  for (const { path, text } of files) {
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      // The command line's error output: the first literal after `stderr:`, not the normal output beside it.
      const stderr = /\bstderr:\s*(.*)$/.exec(line)?.[1];
      if (stderr !== undefined) add(literals(stderr)[0] ?? [], path);
      const nearby = lines.slice(Math.max(0, index - 2), index + 1).join('\n');
      const isMessage = MESSAGE_SITES.some((site) => site.test(line)) || (/\bmessage:\s*['`]/.test(line) && /\b(?:code|kind|rule):/.test(nearby));
      if (!isMessage) return;
      // A call that opens its arguments on the next lines.
      const call = line.trimEnd().endsWith('(') ? lines.slice(index, index + 3).join(' ') : line;
      for (const literal of literals(call)) add(literal, path);
    });
  }
  return messages;
}

/**
 * The string and template literals of a line, in order, each as its fixed
 * parts: a template's `${…}` parts, nested literals included, split it.
 * An escaped line break counts as a space.
 */
function literals(line: string): string[][] {
  const found: string[][] = [];
  let at = 0;
  // Reads the literal that opens at `at`, moving past it.
  const read = (): string[] => {
    const quote = line[at++]!;
    const parts: string[] = [];
    let part = '';
    while (at < line.length && line[at] !== quote) {
      if (line[at] === '\\') {
        const escaped = line[at + 1] ?? '';
        part += escaped === 'n' ? ' ' : escaped;
        at += 2;
      } else if (quote === '`' && line.startsWith('${', at)) {
        at += 2;
        skipExpression();
        parts.push(part);
        part = '';
      } else {
        part += line[at++];
      }
    }
    at++;
    parts.push(part);
    return parts;
  };
  // Moves past the rest of a `${…}` expression and the literals inside it.
  const skipExpression = (): void => {
    let depth = 1;
    while (at < line.length && depth > 0) {
      const char = line[at]!;
      if (char === "'" || char === '"' || char === '`') {
        read();
        continue;
      }
      if (char === '{') depth++;
      if (char === '}') depth--;
      at++;
    }
  };
  while (at < line.length) {
    const char = line[at]!;
    if (char === "'" || char === '"' || char === '`') found.push(read());
    else if (line.startsWith('//', at)) break;
    else at++;
  }
  return found;
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
    for (const message of ['run init at the repository root', 'is not a valid remote name', 'request to Linear failed (', 'setup error (', 'stopped by Linear before any write', 'missing command', 'could not be revoked:', 'does not exist: run initial sync first.']) {
      assert.ok(messages.some((found) => found.includes(message)), `the message collector misses "${message}"`);
    }
    assert.ok(!codes.has('stale') && !messages.includes('Capture Linear changes'), 'the collectors take internal values for messages');
  });
});

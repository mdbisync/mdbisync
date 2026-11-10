// The troubleshooting page against the code: every code a run can report
// and every error or ending message the code can print is on the page, so
// a new message cannot ship without its explanation.
//
// The test reads the tables the code takes them from:
//
// - Codes: every table in `src/codes.ts` and the lint rule names. Each must
//   appear on the page in backticks.
// - Messages: the texts in `src/messages.ts`. Each fixed part of ten letters
//   or more, and the longest part of each text, must appear on the page,
//   with the `{…}` slots left out.
//
// Out of scope, as for the tables: `src/release/` builds releases and is
// never run by users, `src/test-hooks.ts` acts only in tests, and
// `src/format/` (`lint` and `fix`) has its own page,
// `docs/linear-format.md`, with its own test.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as CODES from '../../src/codes.ts';
import { LINT_RULES } from '../../src/format/rules.ts';
import { message, MESSAGES } from '../../src/messages.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PAGE = readFileSync(join(ROOT, 'docs/troubleshooting.md'), 'utf8');

/** Every code, with the table that holds it. */
function codes(): Map<string, string> {
  const found = new Map<string, string>();
  for (const [table, values] of Object.entries(CODES)) {
    assert.ok(Array.isArray(values), `src/codes.ts exports ${table}, which is not a table of codes`);
    for (const code of values) if (!found.has(code)) found.set(code, table);
  }
  for (const rule of Object.keys(LINT_RULES)) if (!found.has(rule)) found.set(rule, 'LINT_RULES');
  return found;
}

/** The fixed parts of the texts that must be on the page, each with its key. */
function messageParts(): Map<string, string> {
  const parts = new Map<string, string>();
  const letters = (part: string) => part.replace(/[^A-Za-z]/g, '').length;
  for (const [key, text] of Object.entries(MESSAGES)) {
    const fixed = text.split(/\{\w+\}/).map((part) => part.replace(/\s+/g, ' ').trim()).filter((part) => part.includes(' '));
    // Every long fixed part, and the longest one even when slots cut the text into short pieces.
    const longest = fixed.reduce<string | undefined>((best, part) => (best === undefined || letters(part) > letters(best) ? part : best), undefined);
    for (const part of fixed) {
      if ((letters(part) >= 10 || (part === longest && letters(part) >= 5)) && !parts.has(part)) parts.set(part, key);
    }
  }
  return parts;
}

/** The modules a run uses: everything under `src/` but tests, test helpers and the out-of-scope folders. */
function runSources(): Array<{ path: string; text: string }> {
  const found: Array<{ path: string; text: string }> = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.includes('test-helpers')) found.push({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') });
    }
  };
  walk(join(ROOT, 'src'));
  return found.filter(({ path }) => !['src/release/', 'src/format/', 'src/test-hooks.ts'].some((out) => path.startsWith(out)));
}

const page = PAGE.replace(/\s+/g, ' ');

describe('troubleshooting page', () => {
  it('names every code a run can report', () => {
    const missing = [...codes()].filter(([code]) => !PAGE.includes(`\`${code}\``));
    assert.deepEqual(missing.map(([code, table]) => `${code} (${table})`), [], 'codes missing from docs/troubleshooting.md');
  });

  it('gives every error and ending message the code can print', () => {
    const missing = [...messageParts()].filter(([part]) => !page.includes(part));
    assert.deepEqual(missing.map(([part, key]) => `${part} (${key})`), [], 'messages missing from docs/troubleshooting.md');
  });

  it('holds codes and messages of each kind in the tables', () => {
    // Guards the tables: a refactor that moves a kind of code or message out of them fails here, not silently.
    const all = codes();
    for (const code of ['missing-permission', 'removal-held', 'merge-blocked', 'linear-content-too-large-to-write-back', 'upload-too-large', 'front-matter-boundary', 'title-too-long', 'edit-wins-delete', 'stored-in-lfs', 'nested-team', 'linear-format-hook', 'footnote', 'percent-encode-unsafe-segments', 'capture-translation']) {
      assert.ok(all.has(code), `no table holds ${code}`);
    }
    const texts = Object.values(MESSAGES);
    for (const text of ['run init at the repository root', 'is not a valid remote name', 'request to Linear failed (', 'setup error (', 'stopped by Linear before any write', 'missing command', 'could not be revoked:', 'does not exist: run initial sync first.', 'the Linear app saw no team in two lookups', 'merge commits are not allowed', 'git object', 'must be one of', 'How to fix it']) {
      assert.ok(texts.some((found) => found.includes(text)), `no text holds "${text}"`);
    }
  });

  it('fills a text\'s slots and leaves the rest as it is', () => {
    assert.equal(message('objects.not-blob', { oid: 'abc', type: 'tree' }), 'git object abc is a tree, not a blob');
    assert.equal(message('linear.too-long', { operation: 'UpdateDocument', field: 'content', length: 12, limit: 10 }), 'UpdateDocument: content is 12 characters, Linear accepts at most 10');
    assert.equal(message('cli.missing-command'), 'missing command');
    // A value is put in once, never read as a slot itself.
    assert.equal(message('init.conflicting-folders', { path: '{path}' }), 'conflicting folder options: {path}');
  });

  it('takes the text of errors, failures and warnings from the table, not from literals', () => {
    // A literal sentence at one of these places bypasses the table and so the page. This only looks for
    // literals where a message is given; the codes and texts themselves come from the tables above.
    const sites = [
      // An error, a failed step, a warning or standard error, after any simple arguments such as an operation name.
      String.raw`\b(?:new [A-Za-z]*Error|super|core\.(?:setFailed|warning)|\.warn|stderr\.write|failed|linearCredentialFailure)\((?:\s*(?:[\w.]+|'[^'\n]*'|"[^"\n]*"),)*\s*`,
      // A warning's or a failed check's detail, a setup error given to the check, the command line's error output.
      String.raw`\b(?:detail|error|stderr):\s*`,
      // A returned `<command>: …` line, as a run's endings give it.
      String.raw`\breturn (?=\x60\$\{[\w.]+\}: )`,
      // A message next to a code, kind or rule in the same object.
      String.raw`\b(?:code|kind|rule):[^{}]*?\bmessage:\s*`,
    ];
    // A string or template literal with two words in its text; a template's `${…}` parts are skipped.
    const literal = String.raw`(['"\x60])(?:\$\{(?:[^{}\n]|\{[^{}\n]*\})*\}|(?!\1|\$\{)[^\n])*?[A-Za-z]{2,} [A-Za-z]`;
    const pattern = new RegExp(`(?:${sites.join('|')})${literal}`, 'g');
    const found = runSources().flatMap(({ path, text }) => [...text.matchAll(pattern)].map((match) => `${path}: ${match[0].split('\n').pop()}`));
    assert.deepEqual(found, [], 'literal message text outside src/messages.ts');
  });
});

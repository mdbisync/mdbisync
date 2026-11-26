// Where `fix` turns an emoji shortcode Linear knows into its emoji, shared
// with the comparison with Linear's text so both decide alike.

import { LINEAR_EMOJI } from './linear-emoji.ts';

const DELIMITER = /^[*_~]$/;
// As the parser reads it: a line or paragraph separator and a byte order mark count too.
const UNICODE_WHITESPACE = /^\s$/u;
const UNICODE_PUNCTUATION = /^[\p{P}\p{S}]$/u;

/**
 * Whether the delimiter runs right before `from` and right after `to` (a
 * reference or a shortcode) can open and close the same way when it is
 * replaced by `text`: its first character faces the run before, its last
 * character the run after.
 */
export function sameFlanking(source: string, from: number, to: number, text: string): boolean {
  const chars = [...text];
  const first = chars[0];
  const last = chars.at(-1);
  const kind = (c: string | undefined) => (c === undefined || UNICODE_WHITESPACE.test(c) ? 'space' : UNICODE_PUNCTUATION.test(c) ? 'punctuation' : 'other');
  // Whether a run of `delimiter` between `before` and `after` can open and close.
  const reads = (delimiter: string, before: string | undefined, after: string | undefined): string => {
    const b = kind(before);
    const a = kind(after);
    const left = a !== 'space' && (a !== 'punctuation' || b !== 'other');
    const right = b !== 'space' && (b !== 'punctuation' || a !== 'other');
    if (delimiter !== '_') return `${left} ${right}`;
    return `${left && (!right || b === 'punctuation')} ${right && (!left || a === 'punctuation')}`;
  };
  const delimiterBefore = source[from - 1];
  if (delimiterBefore !== undefined && DELIMITER.test(delimiterBefore)) {
    let start = from - 1;
    while (start > 0 && source[start - 1] === delimiterBefore) start--;
    if (reads(delimiterBefore, codePointBefore(source, start), source[from]) !== reads(delimiterBefore, codePointBefore(source, start), first)) return false;
  }
  const delimiterAfter = source[to];
  if (delimiterAfter !== undefined && DELIMITER.test(delimiterAfter)) {
    let end = to + 1;
    while (end < source.length && source[end] === delimiterAfter) end++;
    if (reads(delimiterAfter, source[to - 1], codePointAt(source, end)) !== reads(delimiterAfter, last, codePointAt(source, end))) return false;
  }
  return true;
}

/** The whole character that ends right before `at`: an emoji is two UTF-16 units. */
function codePointBefore(source: string, at: number): string | undefined {
  if (at <= 0) return undefined;
  const low = source.charCodeAt(at - 1);
  if (low >= 0xdc00 && low <= 0xdfff && at >= 2) {
    const high = source.charCodeAt(at - 2);
    if (high >= 0xd800 && high <= 0xdbff) return source.slice(at - 2, at);
  }
  return source[at - 1];
}

/** The whole character that starts at `at`. */
function codePointAt(source: string, at: number): string | undefined {
  const code = source.codePointAt(at);
  return code === undefined ? undefined : String.fromCodePoint(code);
}

/** The `:name:` shortcodes in `raw` that name an emoji Linear knows, with their offsets. */
export function* emojiShortcodes(raw: string): Generator<{ index: number; length: number; emoji: string }> {
  for (const match of raw.matchAll(/:([a-z0-9_+-]+):/g)) {
    const emoji = LINEAR_EMOJI.get(match[1]!);
    // Linear escapes the `*` of the keycap asterisk, so it cannot open emphasis.
    if (emoji) yield { index: match.index, length: match[0].length, emoji: emoji.startsWith('*') ? `\\${emoji}` : emoji };
  }
}

/** Whether the character at `at` follows an odd run of backslashes, which escapes it. */
export function escaped(text: string, at: number): boolean {
  let run = 0;
  while (text[at - 1 - run] === '\\') run++;
  return run % 2 === 1;
}

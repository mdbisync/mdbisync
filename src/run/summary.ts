// Labels and escaping shared by the run's Markdown summaries.
import { type Place } from '../mapping/index.ts';

export function placeLabel(place: Place): string {
  return place.kind === 'project' ? `project "${place.project}" of team "${place.team}"` : `team "${place.team}"`;
}

/**
 * A table cell of untrusted text (a path, a title, an error) that GitHub
 * shows as itself: line breaks become spaces, a pipe stays inside the row,
 * and every character that could start Markdown or HTML (a link, an image,
 * a tag, an entity, a code span, emphasis, math, or GitHub's mentions and
 * references) is backslash-escaped, which GitHub-flavored Markdown shows as
 * the character. A colon is not: it is common in plain text, and an emoji
 * code (`:name:`) only shows a character, never a link.
 *
 * A bare URL that GitHub links by itself takes its text as written, up to the
 * next space or `<`, escapes included, so it is left as written: the link
 * shows its own target and nothing inside it is read as markup. The
 * punctuation GitHub leaves out of the link at its end stays as written too,
 * since there it can neither open emphasis nor start a link. A few rare cases
 * show a backslash instead of a change of markup: a pipe inside a URL, which
 * must stay escaped to keep the row; a backslash inside a URL, where the
 * written part ends and the rest is escaped as usual; and an entity reference
 * (`&amp;`) right at a URL's end.
 */
export function cell(text: string): string {
  const flat = text.replace(/[\r\n]+/g, ' ');
  let result = '';
  let done = 0;
  for (const match of flat.matchAll(BARE_URL)) {
    const url = linkedPart(match[0]);
    const tail = match[0].slice(url.length);
    result += escapeMarkup(flat.slice(done, match.index)) + escape(url, /[\\|]/g) + escape(tail, /[\\&]/g);
    done = match.index + match[0].length;
  }
  return result + escapeMarkup(flat.slice(done));
}

/** Backslash-escapes the characters `chars` matches; it always matches the backslash, so no escape is undone. */
function escape(text: string, chars: RegExp): string {
  return text.replace(chars, (char) => `\\${char}`);
}

function escapeMarkup(text: string): string {
  return escape(text, /[\\`*_~[\]<>!&|$@#]/g);
}

/**
 * A bare URL as GitHub-flavored Markdown finds one: `http://`, `https://` or
 * `www.` after the start, a space, `(`, `*`, `_` or `~`, then a domain with a
 * dot, then everything up to the next space or `<`. The part kept as written
 * ends before a backslash, so a pipe after it cannot lose its escape.
 */
const BARE_URL = /(?<=^|[\s(*_~])(?:https?:\/\/|www\.)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+[^\s<\\]*/gi;

/**
 * The part GFM links: it leaves out trailing punctuation, an unmatched `)` and
 * a trailing entity reference. It moves an end index and keeps the counts of
 * parentheses as it goes: cutting and recounting the whole URL for each
 * trailing character took time that grows with the square of their number.
 */
function linkedPart(url: string): string {
  let end = url.length;
  let open = 0;
  let close = 0;
  for (const char of url) {
    if (char === '(') open++;
    else if (char === ')') close++;
  }
  for (;;) {
    const entity = trailingEntity(url, end);
    if (entity !== -1) end = entity;
    else if (end > 0 && TRAILING_PUNCTUATION.includes(url[end - 1]!)) end--;
    else if (url[end - 1] === ')' && close > open) {
      close--;
      end--;
    } else return url.slice(0, end);
  }
}

const TRAILING_PUNCTUATION = `?!.,:*_~'"`;

/** Where an entity reference (`&name;`) that ends `url` before `end` starts, or -1. */
function trailingEntity(url: string, end: number): number {
  if (url[end - 1] !== ';') return -1;
  let at = end - 1;
  while (at > 0 && /[A-Za-z0-9]/.test(url[at - 1]!)) at--;
  return at < end - 1 && url[at - 1] === '&' ? at - 1 : -1;
}

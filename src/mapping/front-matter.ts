// YAML front matter at the start of a Markdown file, found exactly where the
// format module splits it off, so the mapping and the text sent to Linear
// agree on where the front matter ends.

import { parse } from 'yaml';
import { splitFile } from '../format/markdown.ts';

export interface FrontMatter {
  /** The YAML between the fence lines, without them. */
  yaml: string;
}

const OPENING_FENCE = /^﻿?---[ \t]*\r?\n/;
const CLOSING_FENCE = /^---[ \t]*(?:\r?\n|$)/m;

/** Finds the front matter block, or returns null when the text has none. */
export function findFrontMatter(text: string): FrontMatter | null {
  const { head } = splitFile(text);
  const opening = OPENING_FENCE.exec(head);
  if (opening === null) return null;
  const rest = head.slice(opening[0].length);
  const closing = CLOSING_FENCE.exec(rest);
  return closing === null ? null : { yaml: rest.slice(0, closing.index) };
}

/**
 * Parses YAML from a repository file without printing anything: the parser's
 * own warnings and error messages quote the source, which may be content.
 * Throws a message-free error when the YAML is invalid.
 */
export function parseQuietly(yaml: string): unknown {
  return parse(yaml, { logLevel: 'error', prettyErrors: false });
}

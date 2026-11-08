// YAML front matter at the start of a Markdown file: a `---` line, the
// YAML, and a closing `---` (or `...`) line. A byte order mark before the
// opening line is allowed.

export interface FrontMatter {
  /** The YAML between the fence lines, without them. */
  yaml: string;
  /** Index in the text just after the closing fence line. */
  end: number;
}

const OPEN = /^﻿?---[ \t]*\r?\n/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;

/** Finds the front matter block, or returns null when the text has none. */
export function findFrontMatter(text: string): FrontMatter | null {
  const open = OPEN.exec(text);
  if (open === null) return null;
  const rest = text.slice(open[0].length);
  const close = CLOSE.exec(rest);
  if (close === null) return null;
  return { yaml: rest.slice(0, close.index), end: open[0].length + close.index + close[0].length };
}

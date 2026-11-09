// Lint rules: Markdown that Linear would lose or alter. `fix` never rewrites
// a file with one of these; the author decides what to keep.

export const LINT_RULES = {
  footnote: 'Footnotes are dropped.',
  subscript: 'Tilde subscript is dropped.',
  'table-escaped-pipe': 'An escaped pipe in a plain table cell splits the row.',
  'table-hash-cell': 'A table body cell holding only # becomes an empty heading.',
  'image-in-link': 'The link around an image is dropped.',
  'content-too-long': 'Documents over 250,000 characters are rejected.',
  'duplicate-title': 'Two files map to one document title.',
  'table-alignment': 'Table column alignment is dropped.',
  'link-title': 'A link title is dropped.',
  'image-title': 'An image title is dropped from the Markdown.',
  'code-in-emphasis': 'Bold or italic around inline code is dropped from the code.',
  'hard-break-backslash': 'A backslash line break becomes a plain line break.',
  'git-conflict-marker': 'Git conflict marker lines are rewritten as headings, quotes or collapsible sections.',
  'url-in-html': 'A URL inside raw HTML is turned into a Markdown link.',
  'block-first-in-list-item': 'A list item that starts with a heading, code or quote is written in a form Markdown reads as an empty item.',
} as const;

export type LintRule = keyof typeof LINT_RULES;

export interface Finding {
  readonly file: string;
  /** 1-based line in the file, front matter included. */
  readonly line: number;
  readonly rule: LintRule;
  readonly message: string;
}

/** Linear refuses content longer than this, counted in code points. */
export const CONTENT_LIMIT = 250_000;

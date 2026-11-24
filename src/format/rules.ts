// Lint rules: Markdown that formatting or sync would lose or alter. `fix` never rewrites
// a file with one of these; the author decides what to keep.

import { CONTENT_LIMIT } from '../linear/facts.ts';

export { CONTENT_LIMIT };

export const LINT_RULES = {
  footnote: 'Footnotes are dropped.',
  subscript: 'Tilde subscript is dropped.',
  'table-escaped-pipe': 'An escaped pipe in a plain table cell splits the row.',
  'table-hash-cell': 'A table body cell starting with # becomes a heading.',
  'image-in-link': 'The link around an image is dropped.',
  'content-too-long': `This document exceeds Linear's ${CONTENT_LIMIT.toLocaleString('en-US')}-character content limit. The author must decide how to shorten or split it.`,
  'markdown-complexity': 'Markdown trees over 128 levels deep or 500,000 nodes are rejected, as are tables whose short rows, padded to the header width, would add over 250,000 characters or take the tree over that node limit, reference links whose destinations, each written in full, would take the text over 250,000 characters, and paragraphs whose inline syntax, or whose many lines continued without their quote or list prefix, would take too long to parse.',
  'duplicate-title': 'Two or more files map to one document title.',
  'table-alignment': 'Table column alignment is dropped.',
  'link-scheme': 'Links must use http, https, mailto, a path or a fragment.',
  'link-title': 'A link title is dropped.',
  'image-title': 'An image title is dropped from the Markdown.',
  'code-in-emphasis': 'Bold or italic around inline code is dropped from the code.',
  'hard-break-backslash': 'A backslash line break becomes a plain line break.',
  'hard-break-in-heading': 'A hard line break in a setext heading is lost when the heading is written as one line.',
  'git-conflict-marker': 'Git conflict marker lines are rewritten as headings, quotes or collapsible sections.',
  'url-in-html': 'A URL inside raw HTML is turned into a Markdown link.',
  'block-first-in-list-item': 'A list item that starts with a heading, code or quote is written in a form Markdown reads as an empty item.',
  'image-not-in-repository': 'An image must be a relative path to a file of the repository, not a URL, an absolute path or a path outside it.',
  'image-file-missing': 'An image must name a file that exists in the repository, not a folder or a Markdown document.',
  'upload-file-refused': 'A file named as the sync names a captured upload fails the upload check: documents that link it are blocked when they change in Linear.',
  'document-in-assets-folder': 'A Markdown document cannot be inside a folder named assets, which holds the files documents embed.',
} as const;

export type LintRule = keyof typeof LINT_RULES;

/**
 * Rules about where an image's file is, not about what Linear loses. The
 * sync rewrites a document's images into upload URLs before it brings the
 * text into Linear's form, so `fixText` does not stop at these; the `fix`
 * command still leaves a file with any finding to its author.
 */
export const IMAGE_PLACE_RULES: ReadonlySet<LintRule> = new Set<LintRule>(['image-not-in-repository', 'image-file-missing']);

export interface Finding {
  readonly file: string;
  /** 1-based line in the file, front matter included. */
  readonly line: number;
  readonly rule: LintRule;
  readonly message: string;
}

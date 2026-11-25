// Lint rules: Markdown that formatting or sync would lose or alter. `fix` never rewrites
// a file with one of these, except the FIXED_RULES it writes in Linear's form; the
// author decides what to keep. A rewrite can still take a file past the content limit:
// `fix` saves it, and content-too-long reports it. Each message says what Linear does
// and what the author can do about it.

import { CONTENT_LIMIT } from '../linear/facts.ts';

export { CONTENT_LIMIT };

export const LINT_RULES = {
  footnote: 'Footnotes are dropped.',
  subscript: 'Tilde subscript is dropped.',
  'table-escaped-pipe': 'An escaped pipe in a plain table cell splits the row. Put the cell text in inline code, or rephrase it without the pipe.',
  'table-hash-cell': 'A table body cell starting with # becomes a heading.',
  'table-list-cell': 'A table body cell starting with -, + or * and a space, or with a number and ), becomes a list, which Linear writes with * or a number and a dot. Put a backslash before the -, + or *, or reword the cell.',
  'image-in-link': 'The link around an image is dropped.',
  'content-too-long': "This document exceeds Linear's 250,000-character content limit. The author must decide how to shorten or split it.",
  'markdown-complexity': 'Markdown trees over 128 levels deep or 500,000 nodes are rejected, as are tables whose short rows, padded to the header width, would add over 250,000 characters or take the tree over that node limit, reference links whose destinations, each written in full, would take the text over 250,000 characters, and paragraphs whose inline syntax, or whose many lines continued without their quote or list prefix, would take too long to parse.',
  'duplicate-title': 'Two or more files map to one document title.',
  'table-alignment': 'Table column alignment is dropped. Remove the colons from the separator row to accept that.',
  'link-scheme': 'Links must use http, https, mailto, a path or a fragment. Change the destination, or write the address as inline code.',
  'link-title': 'A link title is dropped. Remove the title, or move its text into the link text.',
  'image-title': 'An image title is dropped from the Markdown. Remove the title, or move its text into the alt text.',
  'code-in-emphasis': 'Bold or italic around inline code is dropped from the code. Write the code without emphasis, or emphasize the words around it.',
  'hard-break-backslash': 'A backslash line break becomes a plain line break. Run fix to write it as Linear does; where fix leaves it, put the text on one line or start a new paragraph.',
  'setext-heading-lines': 'Linear keeps only the first line of a heading underlined with = or - as the heading; the lines after it become a paragraph. Put the heading text on one line.',
  'table-header-pipe': 'A table whose header row has no | is plain text in Linear. Write the header row between pipes, as | Total |.',
  'hard-break-in-heading': 'A hard line break in a setext heading is lost when the heading is written as one line. Put the heading on one line, or move the text after the break below it.',
  'number-paragraph': 'A paragraph that is only a number and a dot or parenthesis, such as 7\\., comes back from Linear without the backslash, which reads as an empty numbered list item. Add text after the number, or remove the line.',
  'tab-reference-layout': 'Linear writes tab character references as literal tabs. Fix leaves this document as-is because a tab would change how Markdown reads it. Reword the text or use ordinary spacing.',
  'git-conflict-marker': 'Git conflict marker lines are rewritten as headings, quotes or collapsible sections. Resolve the conflict.',
  'section-opener': 'A line starting with >>> opens a collapsible section in Linear, which fix cannot write here: the file also has lines starting with +++, which Linear pairs with it, or the section would end inside code. Write the section with +++ lines, or start the line with \\>.',
  'url-in-html': 'A URL inside raw HTML is turned into a Markdown link.',
  'unplaced-link': 'A web address Markdown finds inside other text, such as "www.example.com" in quotes, cannot be matched to its text in the source, for example because an escape or a character reference spells it, so fix cannot write it as a link. Write it in angle brackets or as a link.',
  'block-first-in-list-item': 'A list item that starts with a heading, code, a quote or another block is written in a form Markdown reads as an empty item. Start the item with a line of text and put the block below it.',
  'ordered-task-list': 'An ordered task list becomes a bullet task list. Use a bullet task list, or an ordered list without checkboxes.',
  'image-not-in-repository': 'An image must be a relative path to a file of the repository, not a URL, an absolute path or a path outside it. Add the file to the repository and link it by its relative path.',
  'image-file-missing': 'An image must name a file that exists in the repository, not a folder or a Markdown document.',
  'upload-file-refused': 'A file named as the sync names a captured upload fails the upload check: documents that link it are blocked when they change in Linear.',
  'document-in-assets-folder': 'A Markdown document cannot be inside a folder named assets, which holds the files documents embed.',
} as const;

export type LintRule = keyof typeof LINT_RULES;

/**
 * Rules whose construct `fix` rewrites into Linear's form without changing
 * what the Markdown says: `lint` reports them until it has, and neither
 * `fixText` nor the `fix` command stops at them. The sync still leaves such
 * a file out until it is fixed. A backslash line break becomes a two-space
 * break, which Linear keeps; where that would change the document (a break
 * in a heading, which `fix` writes on one line, or a line that reads
 * differently without its backslash), `fixText` leaves the text as it is.
 */
export const FIXED_RULES: ReadonlySet<LintRule> = new Set<LintRule>(['hard-break-backslash']);

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

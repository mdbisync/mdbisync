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
  'table-escaped-pipe': 'A pipe in a plain table cell, escaped or written as a character reference, comes back from Linear unescaped, which splits the row. Put the cell text in inline code, or rephrase it without the pipe.',
  'table-hash-cell': 'A table body cell starting with # becomes a heading.',
  'table-list-cell': 'A table body cell starting with -, + or * and a space, or with a number and ), becomes a list, which Linear writes with * or a number and a dot. Put a backslash before the -, + or *, or reword the cell.',
  'table-quote-cell': 'A table body cell starting with > becomes a quote, and Linear drops the >; a cell starting with >> can take the rows and text below it into the cell. Run fix to write it as \\>, or put a backslash before the > yourself.',
  'image-in-link': 'The link around an image is dropped.',
  'content-too-long': "This document exceeds Linear's 250,000-character content limit. Linear refuses the whole document, so the sync leaves the file out until it fits. The author must decide how to shorten or split it.",
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
  'code-span-padding': 'Linear drops a space at each end of inline code that starts and ends with a space, or that holds only three spaces or more, so the code reads differently. Remove the spaces at the ends of the code, or keep a space at one end only; write code of spaces alone as one or two spaces.',
  'hard-break-in-heading': 'A hard line break in a setext heading is lost when the heading is written as one line. Put the heading on one line, or move the text after the break below it.',
  'number-paragraph': 'A paragraph that is only a number and a dot or parenthesis, such as 7\\., comes back from Linear without the backslash, which reads as an empty numbered list item. Add text after the number, or remove the line.',
  'tab-reference-layout': 'Linear writes tab character references as literal tabs. Fix leaves this document as-is because a tab would change how Markdown reads it. Reword the text or use ordinary spacing.',
  'space-reference-edge': 'Linear stores a space character reference at the start or end of a paragraph, heading or list item as a space, and drops that space the next time the document is written, so no form of this text stays the same in Linear. Fix leaves this document as-is. Remove the reference, or keep the space inside the text.',
  'git-conflict-marker': 'Git conflict marker lines are rewritten as headings, quotes or collapsible sections. Resolve the conflict.',
  'section-opener': 'A line starting with >>> opens a collapsible section in Linear, which fix cannot write here: a section line without a title would open a section inside another one, or a >>> line without a title follows a +++ line that closed its sections, or a ++++ line, code or HTML would take in a closing line. Close a >>> section with a >>> line and a +++ section with a +++ line, or start the line with \\>.',
  'url-in-html': 'A URL inside raw HTML is turned into a Markdown link.',
  'unplaced-link': 'A web address Markdown finds inside other text, such as "www.example.com" in quotes, cannot be matched to its text in the source, for example because an escape or a character reference spells it, so fix cannot write it as a link. Write it in angle brackets or as a link.',
  'list-after-item-text': 'In a list item, Linear writes a list on the line right below the text or the list of another kind before it. When its first item is empty, starts with a list, or is numbered other than 1, Markdown reads that marker as part of the text above. Start the list with an item of text, numbered 1 in a numbered list.',
  'list-number-too-long': 'An ordered list numbered past 999999999: Linear numbers its items on from the first number, and Markdown reads a number of more than nine digits as text of the item above it. Start the list at a smaller number.',
  'block-first-in-list-item': 'A list item that starts with a heading, code, a quote, a collapsible section or another block is written in a form Markdown reads as an empty item. Start the item with a line of text and put the block below it.',
  'ordered-task-list': 'An ordered task list becomes a bullet task list. Use a bullet task list, or an ordered list without checkboxes.',
  'image-not-in-repository': 'An image must be a relative path to a file of the repository, not a URL, an absolute path or a path outside it. Add the file to the repository and link it by its relative path, or run fix to write an HTTP(S) image as a link.',
  'image-file-missing': 'An image must name a file that exists in the repository, not a folder or a Markdown document.',
  'upload-file-refused': 'A file named as the sync names a captured upload fails the upload check: documents that link it are blocked when they change in Linear.',
  'document-in-assets-folder': 'A Markdown document cannot be inside a folder named assets, which holds the files documents embed.',
} as const;

export type LintRule = keyof typeof LINT_RULES;

/**
 * Warnings: text that may read differently from what its author meant, which
 * formatting and sync keep as it is. `lint` and `fix` print them, but they
 * never fail a command, a hook or CI, and never leave a file out.
 */
export const LINT_WARNINGS = {
  'image-made-link': 'fix wrote an image from a URL as a link to it, or as the text of the link around it: Linear shows no image. To show the image, add the file to the repository and link it by its relative path.',
  'list-number-as-text': "A line in a list item starts with a number that Markdown reads as text of the item, though it looks like a nested numbered list: a nested list numbered other than 1 cannot follow the item's text, and a list indented four or more columns past the item's text is part of it. To make it a list, renumber its first item to 1., move it one level up, or remove a doubled number such as 14. 13. in the line above, and remove the backslash fix writes after each of its numbers (2\\.).",
} as const;

export type LintWarningRule = keyof typeof LINT_WARNINGS;

export interface Warning {
  readonly file: string;
  /** 1-based line in the file, front matter included. */
  readonly line: number;
  readonly rule: LintWarningRule;
  readonly message: string;
}

/**
 * Rules whose construct `fix` rewrites into Linear's form without changing
 * what the Markdown says: `lint` reports them until it has, and neither
 * `fixText` nor the `fix` command stops at them. The sync still leaves such
 * a file out until it is fixed. A backslash line break becomes a two-space
 * break, which Linear keeps; where that would change the document (a break
 * in a heading, which `fix` writes on one line, or a line that reads
 * differently without its backslash), `fixText` leaves the text as it is.
 * A `>` that starts a table body cell gets a backslash, the form Linear
 * writes for that text; lint's FIX_ONLY_RULES lets the sync send such a
 * file as it is, since Linear's own export can hold it.
 */
export const FIXED_RULES: ReadonlySet<LintRule> = new Set<LintRule>(['hard-break-backslash', 'table-quote-cell']);

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

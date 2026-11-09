// The format module: `lint` and `fix` for Markdown in Linear's form.

export { fixText, linkedFileCheck, relativeLinkUrls, type FixOptions } from './fix.ts';
export { linkedFileResolver } from './command.ts';
export { duplicateTitles, lintText } from './lint.ts';
export { sameMarkdown, splitFile } from './markdown.ts';
export { CONTENT_LIMIT, LINT_RULES, type Finding, type LintRule } from './rules.ts';

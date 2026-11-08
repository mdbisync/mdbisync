// The format module: `lint` and `fix` for Markdown in Linear's form.

export { fixText } from './fix.ts';
export { duplicateTitles, lintText } from './lint.ts';
export { splitFile } from './markdown.ts';
export { CONTENT_LIMIT, LINT_RULES, type Finding, type LintRule } from './rules.ts';

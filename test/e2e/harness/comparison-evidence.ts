// Diagnostic copies only: assertions always compare the original, unredacted bodies.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sameMarkdown } from '../../../src/format/markdown.ts';

/** Hide signed upload paths while keeping angle brackets, link closers and titles visible. */
export function redactUploadUrls(text: string): string {
  return text.replace(/https:\/\/uploads\.linear\.app\/[^\s<>"'`]+/gi, (match) => {
    // Parentheses may belong to the URL. Only an unmatched closer ends its destination.
    let depth = 0;
    let end = match.length;
    for (let at = 0; at < match.length; at += 1) {
      if (match[at] === '(') depth += 1;
      if (match[at] === ')' && depth-- === 0) { end = at; break; }
    }
    const url = match.slice(0, end);
    // Equal URLs keep equal placeholders; differing URLs remain distinguishable in the evidence.
    const digest = createHash('sha256').update(url).digest('hex');
    return `https://uploads.linear.app/redacted-${digest}${match.slice(end)}`;
  });
}

/** Keep every input to an image-repair subject, including missing content, before cleanup removes it. */
export function imageRepairComparison(
  runDir: string,
  subject: string,
  pairs: ReadonlyArray<{ expected: string; actual: string | null | undefined }>,
): boolean {
  const comparisons = pairs.map(({ expected, actual }) => ({
    expected: redactUploadUrls(expected),
    actual: actual == null ? null : redactUploadUrls(actual),
    equal: expected === actual,
    sameMarkdown: actual != null && sameMarkdown(expected, actual),
  }));
  writeFileSync(join(runDir, `image-repair-${subject}.json`), `${JSON.stringify(comparisons, null, 2)}\n`);
  return comparisons.every(comparison => comparison.sameMarkdown);
}

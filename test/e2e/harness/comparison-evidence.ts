// Diagnostic copies only: assertions always compare the original, unredacted bodies.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sameMarkdown } from '../../../src/format/markdown.ts';
import { redactCredentials } from './person-git.ts';

/** Hide signed upload paths while keeping angle brackets, link closers and titles visible. */
export function redactUploadUrls(text: string): string {
  const placeholder = (url: string) => `https://uploads.linear.app/redacted-${createHash('sha256').update(url).digest('hex')}`;
  const pattern = /<https:\/\/uploads\.linear\.app\/[^<>\r\n]*>|https:\/\/uploads\.linear\.app\/[^\s<>`]+/gi;
  let result = '';
  let cursor = 0;
  let found: RegExpExecArray | null;
  while ((found = pattern.exec(text)) !== null) {
    const match = found[0];
    // Angle destinations allow spaces and unmatched parentheses as part of the URL.
    const angle = match.startsWith('<');
    // Parentheses may belong to the URL. Only an unmatched closer ends its destination.
    let depth = 0;
    let end = match.length;
    for (let at = 0; !angle && at < match.length; at += 1) {
      if (match[at] === '\\') { at += 1; continue; }
      if (match[at] === '(') depth += 1;
      if (match[at] === ')' && depth-- === 0) { end = at; break; }
    }
    // Equal URLs keep equal placeholders; differing URLs remain distinguishable in the evidence.
    result += text.slice(cursor, found.index) + (angle ? `<${placeholder(match.slice(1, -1))}>` : placeholder(match.slice(0, end)));
    // Resume at the destination's end, so adjacent links are each redacted.
    cursor = found.index + end;
    pattern.lastIndex = cursor;
  }
  return redactCredentials(result + text.slice(cursor));
}

/** Keep every input to an image-repair subject, including missing content, before cleanup removes it. */
export function imageRepairComparison(
  runDir: string,
  subject: string,
  pairs: ReadonlyArray<{ expected: string; actual: string | null | undefined }>,
  log: (message: string) => void = console.warn,
): boolean {
  const comparisons = pairs.map(({ expected, actual }) => ({
    expected: redactUploadUrls(expected),
    actual: actual == null ? null : redactUploadUrls(actual),
    equal: expected === actual,
    sameMarkdown: actual != null && sameMarkdown(expected, actual),
  }));
  try {
    writeFileSync(join(runDir, `image-repair-${subject}.json`), `${JSON.stringify(comparisons, null, 2)}\n`);
  } catch (error) {
    log(`image-repair-${subject}.json not written: ${(error as NodeJS.ErrnoException).code ?? 'write failed'}`);
  }
  return comparisons.every(comparison => comparison.sameMarkdown);
}

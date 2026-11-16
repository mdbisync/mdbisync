// Text from outside the project (a scanner's finding title, an advisory
// title) shown in the Markdown the release scripts write.

/**
 * Untrusted text (a finding's title, as a scanner wrote it) as literal text
 * in a Markdown table cell: one line, links removed, every ASCII punctuation
 * character backslash-escaped so nothing in it becomes markup, and at most
 * 200 characters.
 */
export function literal(text: string): string {
  const plain = text
    .replace(/\s+/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '(link removed)')
    .trim();
  const short = [...plain].length > 200 ? `${[...plain].slice(0, 199).join('')}…` : plain;
  return short.replace(/[!-/:-@[-`{-~]/g, (char) => `\\${char}`);
}

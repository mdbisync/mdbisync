// Validation at report and tooling output boundaries. Text may contain
// Unicode Markdown and normal whitespace, but not binary control characters.
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { message } from '../messages.ts';

export function outputText(value: unknown, limit = 16 * 1024 * 1024): string {
  if (typeof value !== 'string' || value.length > limit || !/^[\t\n\r\x20-\x7e\u00a0-\u{10ffff}]*$/u.test(value)) {
    throw new Error(message('output.invalid-text', { limit }));
  }
  return value;
}

/** A character written out as its `\uXXXX` escape. */
function escapedControl(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

/** Display controls explicitly without losing the result of a completed run. */
export function reportText(value: string, limit = 16 * 1024 * 1024): string {
  return outputText(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, escapedControl), limit);
}

/**
 * A value printed inside one line of output, such as a file name: every C0
 * and C1 control and DEL escaped, tabs and line breaks included, so the value
 * cannot start a new line or drive the terminal. A backslash is escaped too,
 * so a name holding the text of an escape prints apart from one holding the
 * character.
 */
export function lineText(value: string): string {
  return value.replace(/[\u0000-\u001f\u005c\u007f-\u009f]/g, escapedControl);
}

export function outputCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(message('output.invalid-count'));
  return Number(value);
}

/** Resolve a locally chosen file name within its configured output directory. */
export function outputFile(directory: string, name: string): string {
  const base = resolve(directory);
  const file = resolve(base, name);
  const path = relative(base, file);
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error(message('output.outside-directory'));
  return file;
}

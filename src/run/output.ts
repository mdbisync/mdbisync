// Validation at report and tooling output boundaries. Text may contain
// Unicode Markdown and normal whitespace, but not binary control characters.
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function outputText(value: unknown, limit = 16 * 1024 * 1024): string {
  if (typeof value !== 'string' || value.length > limit || !/^[\t\n\r\x20-\x7e\u00a0-\u{10ffff}]*$/u.test(value)) {
    throw new Error('Invalid output text');
  }
  return value;
}

export function outputCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid output count');
  return Number(value);
}

/** Resolve a locally chosen file name within its configured output directory. */
export function outputFile(directory: string, name: string): string {
  const base = resolve(directory);
  const file = resolve(base, name);
  const path = relative(base, file);
  if (path === '' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('Output file escapes its directory');
  return file;
}

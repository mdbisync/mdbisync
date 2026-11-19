// Test helpers for the format module.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type CommandResult, runFix } from './command.ts';

/**
 * What the `linear-format` hook (`mdbisync fix`) does to a file holding `text` at `path`, in a folder that holds
 * only it and the other `files` (their text by path).
 */
export function hookRun(path: string, text: string, files: Readonly<Record<string, string>> = {}): CommandResult {
  const dir = mkdtempSync(join(tmpdir(), 'format-hook-'));
  try {
    for (const [file, content] of Object.entries({ ...files, [path]: text })) {
      mkdirSync(join(dir, dirname(file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    return runFix([path], dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

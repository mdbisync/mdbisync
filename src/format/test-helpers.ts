// Test helpers for the format module.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type CommandResult, runFix } from './command.ts';

/** What the `linear-format` hook (`mdbisync fix`) does to a file holding `text` at `path`, alone in a folder. */
export function hookRun(path: string, text: string): CommandResult {
  const dir = mkdtempSync(join(tmpdir(), 'format-hook-'));
  try {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), text);
    return runFix([path], dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

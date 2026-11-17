// Run any Node test selection in its own empty temporary directory and fail
// if the tests leave files under that directory, even when the runner fails.
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'test-temp-cleanup-'));
try {
  const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], {
    env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
    stdio: 'inherit',
  });
  const interrupt = () => { console.error('Forwarding SIGINT to test runner'); child.kill('SIGINT'); };
  const terminate = () => { console.error('Forwarding SIGTERM to test runner'); child.kill('SIGTERM'); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const leftovers = readdirSync(directory).sort();
    if (leftovers.length > 0) console.error(`Temporary directory cleanup failed: ${leftovers.join(', ')}`);
    if (result.signal) console.error(`Test runner terminated by ${result.signal}`);
    process.exitCode = leftovers.length > 0 ? 1 : result.code ?? (result.signal ? 128 + constants.signals[result.signal] : 1);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
} finally {
  // This directory belongs only to this invocation, including any leftovers.
  rmSync(directory, { recursive: true, force: true });
}

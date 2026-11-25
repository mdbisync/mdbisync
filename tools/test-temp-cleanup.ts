// Run any Node test selection in its own empty temporary directory and fail
// if the tests leave files under that directory, even when the runner fails.
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every test file runs in its own process, which strips the TypeScript
// sources it imports, and every git call forks that process. Node's compile
// cache, shared by those processes and kept between runs, spares the later
// processes and runs that work: they start faster and hold less memory, so
// each fork costs less. Node checks each cached entry against its source.
const compileCache = process.env.NODE_COMPILE_CACHE || fileURLToPath(new URL('../node_modules/.cache/test-compile-cache', import.meta.url));

/** Options of `node --test` that take no value. */
const FLAGS = new Set(['--test-only', '--test-force-exit', '--test-update-snapshots', '--experimental-test-coverage']);

// `npm test -- <options>` appends the options after the script's file
// patterns, where `node --test` silently takes them for more patterns. The
// options that end the arguments are moved ahead of everything else, so they
// apply. Other arguments keep their order. Such an option needs the
// --name=value form unless it takes no value: given apart, its value would
// end the run of options, and moved without one it would take the first
// pattern for its value.
function runnerArguments(args: readonly string[]): string[] {
  let end = args.length;
  while (end > 0 && (args[end - 1] as string).startsWith('-')) end -= 1;
  if (end === 0) return [...args];
  const moved = args.slice(end);
  const bare = moved.find((arg) => !arg.includes('=') && !FLAGS.has(arg));
  if (bare !== undefined) throw new Error(`Write ${bare} after the file patterns as ${bare}=<value>, or put it before them`);
  return [...moved, ...args.slice(0, end)];
}

let runnerArgs: string[];
try {
  runnerArgs = runnerArguments(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
// A warm cache can change what coverage reports, so a coverage run compiles afresh.
const cacheEnv = runnerArgs.includes('--experimental-test-coverage') ? {} : { NODE_COMPILE_CACHE: compileCache };

const directory = mkdtempSync(join(tmpdir(), 'test-temp-cleanup-'));
try {
  const child = spawn(process.execPath, ['--test', ...runnerArgs], {
    env: { ...process.env, ...cacheEnv, TMPDIR: directory, TMP: directory, TEMP: directory },
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

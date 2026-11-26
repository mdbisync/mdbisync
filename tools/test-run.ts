// Runs test files as `node --test` does, but starts the files that took
// longest last time first, a file per CPU. `node --test` sorts its files by
// name, so a long file whose name sorts late starts when most others are done
// and the run waits for it alone. The durations of the last runs are kept
// next to the compile cache; with none, files run in name order.
//
// Usage: node tools/test-run.ts [options] <file patterns>. `plan` says
// whether it takes the arguments; `tools/test-temp-cleanup.ts` runs
// `node --test` itself for any it does not.
import { spawnSync } from 'node:child_process';
import { createWriteStream, globSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { run } from 'node:test';
import * as reporters from 'node:test/reporters';
import { fileURLToPath } from 'node:url';

/** Options this runner takes, in their `--name=value` form, as `node --test` reads them. */
const SUPPORTED = ['--test-concurrency', '--test-name-pattern', '--test-skip-pattern', '--test-reporter', '--test-reporter-destination', '--test-timeout'];

export const DURATIONS_FILE = fileURLToPath(new URL('../node_modules/.cache/test-durations.json', import.meta.url));

export interface Plan {
  patterns: string[];
  concurrency: number;
  namePatterns: string[];
  skipPatterns: string[];
  reporters: { name: string; destination: string }[];
  timeout: number | undefined;
}

/**
 * The run these arguments ask for, or undefined when `node --test` must run
 * them: an option this runner does not take, a reporter that is not built
 * in, or test runner options in `NODE_OPTIONS`.
 */
export function plan(args: readonly string[], nodeOptions = process.env.NODE_OPTIONS ?? ''): Plan | undefined {
  // Test options there, experimental ones included (`--experimental-test-isolation`), change how `node --test` runs.
  if (/(^|\s)--(experimental-)?test/.test(nodeOptions)) return undefined;
  // A file per CPU: `node --test` leaves one CPU to its own process, and this one only passes events on.
  const result: Plan = { patterns: [], concurrency: availableParallelism(), namePatterns: [], skipPatterns: [], reporters: [], timeout: undefined };
  const names: string[] = [];
  const destinations: string[] = [];
  for (const arg of args) {
    if (!arg.startsWith('-')) {
      result.patterns.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    const name = equals < 0 ? arg : arg.slice(0, equals);
    if (equals < 0 || !SUPPORTED.includes(name)) return undefined;
    const value = arg.slice(equals + 1);
    if (name === '--test-concurrency') {
      if (!/^[1-9][0-9]*$/.test(value)) return undefined;
      result.concurrency = Number(value);
    } else if (name === '--test-timeout') {
      if (!/^[0-9]+$/.test(value)) return undefined;
      result.timeout = Number(value);
    } else if (name === '--test-name-pattern') result.namePatterns.push(value);
    else if (name === '--test-skip-pattern') result.skipPatterns.push(value);
    else if (name === '--test-reporter') names.push(value);
    else destinations.push(value);
  }
  if (names.some((name) => !Object.hasOwn(reporters, name))) return undefined;
  // As `node --test`: reporters and destinations pair in order; a single reporter needs no destination.
  if ((names.length > 1 || destinations.length > 0) && destinations.length !== names.length) return undefined;
  result.reporters = (names.length > 0 ? names : ['spec']).map((name, index) => ({ name, destination: destinations[index] ?? 'stdout' }));
  return result.patterns.length > 0 ? result : undefined;
}

/**
 * The files the patterns match, as `node --test` finds them (never under
 * `node_modules`), longest last time first and in name order otherwise.
 */
export function orderedFiles(patterns: readonly string[], durations: Readonly<Record<string, number>>): string[] {
  const found = globSync([...patterns], { exclude: (entry: string) => entry.split(/[\\/]/).at(-1) === 'node_modules' });
  const files = [...new Set(found.map((file) => relative(process.cwd(), resolve(file))))].sort();
  // A stable sort keeps name order among files of the same duration, and files with none last.
  return files.sort((a, b) => (durations[b] ?? 0) - (durations[a] ?? 0));
}

function readDurations(): Record<string, number> {
  try {
    const data = JSON.parse(readFileSync(DURATIONS_FILE, 'utf8')) as unknown;
    return typeof data === 'object' && data !== null ? data as Record<string, number> : {};
  } catch {
    return {};
  }
}

/** Keeps the durations for the next run's order; only an aid, so a failure to keep them changes nothing else. */
function writeDurations(durations: Record<string, number>): void {
  try {
    mkdirSync(dirname(DURATIONS_FILE), { recursive: true });
    const temporary = `${DURATIONS_FILE}.${process.pid}`;
    writeFileSync(temporary, JSON.stringify(durations, null, 1));
    renameSync(temporary, DURATIONS_FILE);
  } catch {
    // The next run orders by what it finds.
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const chosen = plan(args);
  if (chosen === undefined) {
    console.error('tools/test-run.ts: these arguments are for node --test');
    process.exitCode = 2;
    return;
  }
  const durations = readDurations();
  const files = orderedFiles(chosen.patterns, durations);
  // No file found: `node --test` tells a pattern that matched nothing from a missing file.
  if (files.length === 0) {
    process.exitCode = spawnSync(process.execPath, ['--test', ...args], { stdio: 'inherit' }).status ?? 1;
    return;
  }
  const abort = new AbortController();
  // The first interrupt stops the run, which then ends its test processes; later ones change nothing.
  const stop = () => abort.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const stream = run({
    files,
    concurrency: chosen.concurrency,
    signal: abort.signal,
    ...(chosen.namePatterns.length > 0 ? { testNamePatterns: chosen.namePatterns } : {}),
    ...(chosen.skipPatterns.length > 0 ? { testSkipPatterns: chosen.skipPatterns } : {}),
    ...(chosen.timeout === undefined ? {} : { timeout: chosen.timeout }),
  });
  let success = false;
  const measured = new Map<string, number>();
  const failedFiles = new Set<string>();
  // The run's own summary, the one without a file, says whether it passed, as `node --test` decides its exit code.
  stream.on('test:summary', (data: { file?: string; success: boolean }) => { if (data.file === undefined) success = data.success; });
  stream.on('test:fail', (data: { nesting: number; file?: string }) => { if (data.nesting === 0 && data.file !== undefined) failedFiles.add(data.file); });
  stream.on('test:complete', (data: { nesting: number; file?: string; details: { duration_ms: number } }) => {
    if (data.nesting === 0 && data.file !== undefined) measured.set(data.file, (measured.get(data.file) ?? 0) + data.details.duration_ms);
  });
  // Every reporter reads all events: each gets its own copy.
  const copies = chosen.reporters.map(() => new PassThrough({ objectMode: true }));
  stream.on('data', (event) => { for (const copy of copies) copy.write(event); });
  stream.on('end', () => { for (const copy of copies) copy.end(); });
  await Promise.all(chosen.reporters.map(async ({ name, destination }, index) => {
    const reported = (copies[index] as PassThrough).compose((reporters as Record<string, unknown>)[name] as never) as Readable;
    if (destination === 'stdout' || destination === 'stderr') {
      const target = destination === 'stdout' ? process.stdout : process.stderr;
      for await (const chunk of reported) target.write(chunk);
      return;
    }
    mkdirSync(dirname(resolve(destination)), { recursive: true });
    await pipeline(reported, createWriteStream(resolve(destination)));
  }));
  // Only a whole run says how long a file takes: not one cut short or filtered, nor a file that failed.
  if (!abort.signal.aborted && chosen.namePatterns.length === 0 && chosen.skipPatterns.length === 0) {
    for (const [file, ms] of measured) {
      const key = relative(process.cwd(), file);
      if (!failedFiles.has(file) && !isAbsolute(key) && !key.startsWith(`..${sep}`)) durations[key] = ms;
    }
    writeDurations(durations);
  }
  process.exitCode = success && !abort.signal.aborted ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

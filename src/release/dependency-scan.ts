import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import { literal } from './markdown-text.ts';
import { validateSha, validateVersion } from './package.ts';

// The dependency check of the project: every npm lock file of a commit,
// audited by `npm audit` against the public advisory database, minus the
// exceptions the repository keeps in one file. The release gate runs it on
// the source being released, and a scheduled workflow runs it on `main` and
// on the latest final release, so a new advisory against a released version
// shows up without anyone asking. It reads public data only and needs no
// credential.

export const EXCEPTIONS_FILE = 'security/dependency-exceptions.json';
// The full machine-readable result of one check.
export const RESULT_FILE = 'dependency-result.json';
// The small public status of a release's dependencies, attached to the release.
export const STATUS_FILE = 'dependency-scan.json';
export const RESULT_SCHEMA = 1;
export const STATUS_SCHEMA = 1;

// npm's severities, most severe first. A finding of moderate or higher blocks a release.
const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'] as const;
export type Severity = typeof SEVERITIES[number];
export const BLOCKING: readonly Severity[] = ['critical', 'high', 'moderate'];

const ADVISORY_ID = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/;
const ADVISORY_URL = /^https:\/\/github\.com\/advisories\/(GHSA(?:-[23456789cfghjmpqrvwx]{4}){3})$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface Exception {
  advisory: string;
  package: string;
  reason: string;
  // The date by which the exception is reviewed again. After it, the exception no longer applies.
  review: string;
}

export interface Exceptions { active: Exception[]; expired: Exception[] }

interface Affected { name: string; lockFile: string; range: string }

export interface Advisory {
  // The GHSA id, or npm's own advisory id when the advisory has no GHSA id.
  id: string;
  severity: Severity;
  title: string;
  url: string;
  packages: Affected[];
}

export interface Excepted extends Advisory { exceptions: Exception[] }

export interface Counts { critical: number; high: number; moderate: number; low: number; info: number }

export interface Result {
  schema: typeof RESULT_SCHEMA;
  target: string;
  commit: string;
  // The release the commit belongs to, when it is one.
  release: string | null;
  checked: string;
  lockFiles: string[];
  // Advisories that still apply: counted once each, however many packages and lock files they reach.
  open: Advisory[];
  // Advisories that apply only to packages the exceptions file covers.
  excepted: Excepted[];
  expiredExceptions: Exception[];
  counts: Counts;
}

export interface Status {
  schema: typeof STATUS_SCHEMA;
  release: string;
  commit: string;
  checked: string;
  // The run that made this check; its page shows the readable report.
  run: string;
  high: number;
  critical: number;
}

function isDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * The exceptions file: every entry checked, and split into the ones that
 * apply on `today` and the ones past their review date, which no longer do.
 */
export function parseExceptions(text: string, today: string): Exceptions {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${EXCEPTIONS_FILE} is not valid JSON`);
  }
  const list = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>).exceptions : undefined;
  if (!Array.isArray(list)) throw new Error(`${EXCEPTIONS_FILE} must hold an object with an "exceptions" list`);
  const seen = new Set<string>();
  const result: Exceptions = { active: [], expired: [] };
  list.forEach((entry: unknown, index) => {
    const where = `${EXCEPTIONS_FILE}, exception ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${where} is not an object`);
    const { advisory, package: name, reason, review, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw new Error(`${where} has unknown fields: ${Object.keys(rest).join(', ')}`);
    if (typeof advisory !== 'string' || !ADVISORY_ID.test(advisory)) throw new Error(`${where}: "advisory" must be a GHSA id`);
    if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) throw new Error(`${where}: "package" must be an npm package name`);
    if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 200) throw new Error(`${where}: "reason" must be a text of at most 200 characters`);
    if (typeof review !== 'string' || !isDate(review)) throw new Error(`${where}: "review" must be a date such as 2027-01-31`);
    const key = `${advisory} ${name}`;
    if (seen.has(key)) throw new Error(`${where} repeats ${advisory} for ${name}`);
    seen.add(key);
    const exception = { advisory, package: name, reason: reason.trim(), review };
    (review < today ? result.expired : result.active).push(exception);
  });
  return result;
}

function rank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

/**
 * The advisories in the JSON output of `npm audit` for one lock file. Each
 * vulnerable package lists in `via` the advisories that affect it directly
 * (objects) and the vulnerable packages it depends on (names); only the
 * advisories count, so a package that is vulnerable only through another is
 * not counted twice.
 */
export function advisoriesOf(audit: unknown, lockFile: string): Advisory[] {
  const report = audit && typeof audit === 'object' && !Array.isArray(audit) ? audit as Record<string, unknown> : {};
  if (report.error !== undefined) throw new Error(`npm audit failed for ${lockFile}: ${JSON.stringify(report.error).slice(0, 300)}`);
  const vulnerabilities = report.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities !== 'object' || Array.isArray(vulnerabilities)) throw new Error(`npm audit returned no vulnerability list for ${lockFile}`);
  const found: Advisory[] = [];
  for (const vulnerability of Object.values(vulnerabilities)) {
    const via = vulnerability && typeof vulnerability === 'object' ? (vulnerability as Record<string, unknown>).via : undefined;
    if (!Array.isArray(via)) throw new Error(`npm audit returned a vulnerability without "via" for ${lockFile}`);
    for (const cause of via) {
      if (typeof cause === 'string') continue;
      const { source, name, title, url, severity, range } = (cause ?? {}) as Record<string, unknown>;
      if (typeof name !== 'string' || !SEVERITIES.includes(severity as Severity)) throw new Error(`npm audit returned an advisory without a package or a known severity for ${lockFile}`);
      const ghsa = typeof url === 'string' ? ADVISORY_URL.exec(url)?.[1] : undefined;
      if (ghsa === undefined && typeof source !== 'number') throw new Error(`npm audit returned an advisory without an id for ${lockFile}`);
      found.push({
        id: ghsa ?? `npm-${String(source)}`,
        severity: severity as Severity,
        title: typeof title === 'string' ? title : '',
        url: typeof url === 'string' ? url : '',
        packages: [{ name, lockFile, range: typeof range === 'string' ? range : '' }],
      });
    }
  }
  return found;
}

/** One entry per advisory id, with every package and lock file it reaches and its highest severity. */
function merge(advisories: Advisory[]): Advisory[] {
  const byId = new Map<string, Advisory>();
  for (const advisory of advisories) {
    const known = byId.get(advisory.id);
    if (known === undefined) {
      byId.set(advisory.id, { ...advisory, packages: [...advisory.packages] });
      continue;
    }
    if (rank(advisory.severity) < rank(known.severity)) known.severity = advisory.severity;
    if (known.title === '') known.title = advisory.title;
    if (known.url === '') known.url = advisory.url;
    for (const affected of advisory.packages) {
      if (!known.packages.some((p) => p.name === affected.name && p.lockFile === affected.lockFile)) known.packages.push(affected);
    }
  }
  const sorted = [...byId.values()];
  for (const advisory of sorted) advisory.packages.sort((a, b) => a.lockFile.localeCompare(b.lockFile) || a.name.localeCompare(b.name));
  return sorted.sort((a, b) => rank(a.severity) - rank(b.severity) || a.id.localeCompare(b.id));
}

export interface ScanInput {
  target: string;
  commit: string;
  release: string | null;
  checked: string;
  // Each lock file's path in the repository and the `npm audit` JSON for it.
  audits: { lockFile: string; audit: unknown }[];
  exceptions: Exceptions;
}

/** The result of a check: the advisories split into open and excepted, and the open ones counted by severity. */
export function evaluate(input: ScanInput): Result {
  const advisories = merge(input.audits.flatMap(({ lockFile, audit }) => advisoriesOf(audit, lockFile)));
  const open: Advisory[] = [];
  const excepted: Excepted[] = [];
  for (const advisory of advisories) {
    const covering = (name: string) => input.exceptions.active.filter((e) => e.advisory === advisory.id && e.package === name);
    if (advisory.packages.every((affected) => covering(affected.name).length > 0)) {
      const used = advisory.packages.flatMap((affected) => covering(affected.name));
      excepted.push({ ...advisory, exceptions: [...new Map(used.map((e) => [`${e.advisory} ${e.package}`, e])).values()] });
    } else {
      open.push(advisory);
    }
  }
  const counts: Counts = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
  for (const advisory of open) counts[advisory.severity] += 1;
  return {
    schema: RESULT_SCHEMA,
    target: input.target,
    commit: input.commit,
    release: input.release,
    checked: input.checked,
    lockFiles: input.audits.map(({ lockFile }) => lockFile).sort(),
    open,
    excepted,
    expiredExceptions: input.exceptions.expired,
    counts,
  };
}

/** The open advisories that block a release. */
export function blocking(result: Result): Advisory[] {
  return result.open.filter((advisory) => BLOCKING.includes(advisory.severity));
}

/** The public status of a release, which the project site reads without a credential. */
export function releaseStatus(result: Result, run: string): Status {
  if (result.release === null) throw new Error('A release status needs the check of a release');
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[1-9][0-9]*$/.test(run)) throw new Error(`Unexpected run URL: ${run}`);
  return {
    schema: STATUS_SCHEMA,
    release: result.release,
    commit: result.commit,
    checked: result.checked,
    run,
    high: result.counts.high,
    critical: result.counts.critical,
  };
}

function packagesCell(packages: Affected[]): string {
  return packages.map((p) => `${literal(p.name)} (${literal(p.lockFile)})`).join(', ');
}

function advisoryCell(advisory: Advisory): string {
  // The id is checked; only a GitHub advisory page is ever linked.
  return ADVISORY_URL.test(advisory.url) ? `[${advisory.id}](${advisory.url})` : literal(advisory.id);
}

/** The readable report of a check, for the run's job summary. */
export function renderSummary(result: Result): string {
  const { counts } = result;
  const lines = [
    `## Dependency scan: ${literal(result.target)}`,
    '',
    `Release: ${result.release ?? 'none (a branch)'}. Commit: \`${result.commit}\`. Checked: ${result.checked}.`,
    '',
    `Lock files: ${result.lockFiles.length === 0 ? 'none' : result.lockFiles.map((file) => `\`${file}\``).join(', ')}.`,
    '',
    'Each advisory counts once, however many packages and lock files it reaches.',
    'An advisory of moderate severity or higher blocks a release.',
    '',
    '| Critical | High | Moderate | Low | Info | Excepted |',
    '| --- | --- | --- | --- | --- | --- |',
    `| ${counts.critical} | ${counts.high} | ${counts.moderate} | ${counts.low} | ${counts.info} | ${result.excepted.length} |`,
    '',
    '### Open advisories',
    '',
  ];
  if (result.open.length === 0) {
    lines.push('None.', '');
  } else {
    lines.push('| Advisory | Severity | Packages (lock file) | Title |', '| --- | --- | --- | --- |');
    for (const advisory of result.open) lines.push(`| ${advisoryCell(advisory)} | ${advisory.severity} | ${packagesCell(advisory.packages)} | ${literal(advisory.title)} |`);
    lines.push('');
  }
  lines.push('### Exceptions', '', `Advisories the project excepted in \`${EXCEPTIONS_FILE}\`, with the reason. An exception applies until its review date.`, '');
  if (result.excepted.length === 0) {
    lines.push('None applied.', '');
  } else {
    lines.push('| Advisory | Severity | Package | Reason | Review by |', '| --- | --- | --- | --- | --- |');
    for (const advisory of result.excepted) {
      for (const exception of advisory.exceptions) lines.push(`| ${advisoryCell(advisory)} | ${advisory.severity} | ${literal(exception.package)} | ${literal(exception.reason)} | ${exception.review} |`);
    }
    lines.push('');
  }
  if (result.expiredExceptions.length > 0) {
    lines.push('Past their review date, so no longer applied:', '');
    for (const exception of result.expiredExceptions) lines.push(`- ${exception.advisory} for ${literal(exception.package)}, review was due ${exception.review}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

const run = promisify(execFile);

async function git(repository: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-C', repository, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).stdout;
}

/** Every npm lock file tracked at a commit. */
export async function lockFilesAt(repository: string, commit: string): Promise<string[]> {
  const listing = await git(repository, 'ls-tree', '-r', '-z', '--name-only', commit);
  return listing.split('\0').filter((path) => posix.basename(path) === 'package-lock.json').sort();
}

/**
 * `npm audit` of one lock file at a commit. Only the lock file and its
 * `package.json` are copied out of the repository, so no project npm
 * configuration takes part, and the public registry is named explicitly.
 */
export async function npmAudit(repository: string, commit: string, lockFile: string): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), 'dependency-scan-'));
  try {
    const folder = posix.dirname(lockFile);
    const inRepository = (name: string) => (folder === '.' ? name : `${folder}/${name}`);
    await writeFile(join(directory, 'package-lock.json'), await git(repository, 'show', `${commit}:${lockFile}`));
    await writeFile(join(directory, 'package.json'), await git(repository, 'show', `${commit}:${inRepository('package.json')}`));
    // npm audit exits non-zero when it finds an advisory, so the output decides, not the exit code.
    const output = await run('npm', ['audit', '--package-lock-only', '--json', '--registry=https://registry.npmjs.org/'], {
      cwd: directory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000,
    }).catch((error: { stdout?: string; message?: string }) => {
      if (typeof error.stdout === 'string' && error.stdout.trim() !== '') return { stdout: error.stdout };
      throw new Error(`npm audit failed for ${lockFile}: ${error.message ?? String(error)}`);
    });
    try {
      return JSON.parse(output.stdout);
    } catch {
      throw new Error(`npm audit did not return JSON for ${lockFile}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The source commit of a final release tag, as its release commit records it. */
export async function releaseSource(repository: string, tag: string): Promise<string> {
  validateVersion(tag);
  if (tag.includes('-')) throw new Error('Only a final release is checked');
  const manifest = JSON.parse(await git(repository, 'show', `refs/tags/${tag}:release.json`)) as Record<string, unknown>;
  const source = manifest.source;
  if (manifest.version !== tag || typeof source !== 'string') throw new Error(`release.json of ${tag} does not name its version and source`);
  validateSha(source);
  // The release commit's parent is the source it was built from.
  const parent = (await git(repository, 'rev-parse', `refs/tags/${tag}^{commit}^1`)).trim();
  if (parent !== source) throw new Error(`The release commit of ${tag} is not built on its recorded source ${source}`);
  return source;
}

export interface CheckOptions {
  repository: string;
  commit: string;
  target: string;
  release: string | null;
  exceptionsText: string;
  now?: Date;
  audit?: (repository: string, commit: string, lockFile: string) => Promise<unknown>;
}

export async function check(options: CheckOptions): Promise<Result> {
  const now = options.now ?? new Date();
  const commit = (await git(options.repository, 'rev-parse', '--verify', `${options.commit}^{commit}`)).trim();
  validateSha(commit);
  const exceptions = parseExceptions(options.exceptionsText, now.toISOString().slice(0, 10));
  const audit = options.audit ?? npmAudit;
  const audits = [];
  for (const lockFile of await lockFilesAt(options.repository, commit)) {
    audits.push({ lockFile, audit: await audit(options.repository, commit, lockFile) });
  }
  return evaluate({ target: options.target, commit, release: options.release, checked: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), audits, exceptions });
}

/** Reads a result file that a check wrote, refusing anything that is not one. */
export async function readResult(path: string): Promise<Result> {
  const data = JSON.parse(await readFile(path, 'utf8')) as Result;
  if (data?.schema !== RESULT_SCHEMA || !Array.isArray(data.open) || typeof data.commit !== 'string' || typeof data.counts?.high !== 'number' || typeof data.counts?.critical !== 'number') {
    throw new Error(`${path} is not a dependency scan result`);
  }
  return data;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const usage = 'Usage: dependency-scan.ts --repository DIR --target NAME --output DIR (--commit REF [--version vX.Y.Z] | --release-tag vX.Y.Z) [--run-url URL]';
  const repository = option(args, '--repository');
  const target = option(args, '--target');
  const output = option(args, '--output');
  const releaseTag = option(args, '--release-tag');
  const version = option(args, '--version');
  const runUrl = option(args, '--run-url');
  if (!repository || !target || !output || (releaseTag === undefined) === (option(args, '--commit') === undefined)) throw new Error(usage);
  if (version !== undefined && (releaseTag !== undefined || validateVersion(version).includes('-'))) throw new Error(usage);
  const commit = releaseTag === undefined ? option(args, '--commit')! : await releaseSource(repository, releaseTag);
  const release = releaseTag ?? version ?? null;
  const result = await check({ repository, commit, target, release, exceptionsText: await readFile(EXCEPTIONS_FILE, 'utf8') });
  await mkdir(output, { recursive: true });
  await writeFile(join(output, RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`);
  if (release !== null && runUrl !== undefined) await writeFile(join(output, STATUS_FILE), `${JSON.stringify(releaseStatus(result, runUrl), null, 2)}\n`);
  const summary = renderSummary(result);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `blocking=${blocking(result).length}\n`);
}

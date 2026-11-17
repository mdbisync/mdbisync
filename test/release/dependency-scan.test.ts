import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  advisoriesOf, blocking, check, EXCEPTIONS_FILE, evaluate, lockFilesAt, parseExceptions, releaseSource, releaseStatus, renderSummary,
} from '../../src/release/dependency-scan.ts';

// Each fixture is a real lock file with the `npm audit --package-lock-only --json`
// output recorded for it. The lock file and its manifest are stored under other
// names so the repository's own dependency tools never take them for real ones.
const fixture = (name: string, file: string) => readFileSync(new URL(`./dependency-scan/${name}/${file}`, import.meta.url), 'utf8');
const recorded = (name: string): unknown => JSON.parse(fixture(name, 'audit.json'));

const today = '2026-11-16';
const now = new Date(`${today}T08:30:00.123Z`);
const noExceptions = JSON.stringify({ exceptions: [] });

function exceptionsFile(...entries: Record<string, string>[]): string {
  return JSON.stringify({ about: 'test', exceptions: entries });
}

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
}

/** A repository with the given fixtures as lock files, committed. Returns its directory and commit. */
function repository(lockFiles: Record<string, string>): { directory: string; commit: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'dependency-scan-test-'));
  after(() => rmSync(directory, { recursive: true, force: true }));
  git(directory, 'init', '-q', '-b', 'main');
  for (const [folder, name] of Object.entries(lockFiles)) {
    mkdirSync(join(directory, folder), { recursive: true });
    writeFileSync(join(directory, folder, 'package.json'), fixture(name, 'manifest.json'));
    writeFileSync(join(directory, folder, 'package-lock.json'), fixture(name, 'lock.json'));
  }
  writeFileSync(join(directory, 'README.md'), 'test\n');
  git(directory, 'add', '-A');
  git(directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'source');
  return { directory, commit: git(directory, 'rev-parse', 'HEAD'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

/** An audit that answers each lock file with the recorded output of the fixture it was made from. */
function recordedAudit(byLockFile: Record<string, string>) {
  return async (_repository: string, _commit: string, lockFile: string) => {
    const name = byLockFile[lockFile];
    assert.ok(name, `unexpected lock file ${lockFile}`);
    return recorded(name);
  };
}

test('a vulnerable lock file: every advisory counted once by severity, and the report names packages and advisories', async () => {
  const repo = repository({ '.': 'vulnerable' });
  try {
    const result = await check({
      repository: repo.directory, commit: 'HEAD', target: 'main', release: null, exceptionsText: noExceptions, now,
      audit: recordedAudit({ 'package-lock.json': 'vulnerable' }),
    });
    assert.equal(result.commit, repo.commit);
    assert.equal(result.checked, '2026-11-16T08:30:00Z');
    assert.deepEqual(result.lockFiles, ['package-lock.json']);
    assert.deepEqual(result.counts, { critical: 1, high: 2, moderate: 2, low: 0, info: 0 });
    assert.deepEqual(result.open.map((advisory) => [advisory.id, advisory.severity, advisory.packages.map((p) => p.name).join()]), [
      ['GHSA-xvch-5gv4-984h', 'critical', 'minimist'],
      ['GHSA-35jh-r3h4-6jhm', 'high', 'lodash'],
      ['GHSA-r5fr-rjxr-66jc', 'high', 'lodash'],
      ['GHSA-29mw-wpgm-hmr9', 'moderate', 'lodash'],
      ['GHSA-xxjr-mmjv-4gpg', 'moderate', 'lodash'],
    ]);
    assert.equal(blocking(result).length, 5);
    const summary = renderSummary(result);
    assert.match(summary, /\[GHSA-xvch-5gv4-984h\]\(https:\/\/github\.com\/advisories\/GHSA-xvch-5gv4-984h\) \| critical \| minimist \(package\\-lock\\\.json\)/);
    assert.match(summary, /\| 1 \| 2 \| 2 \| 0 \| 0 \| 0 \|/);
    assert.match(summary, new RegExp(`Commit: \`${repo.commit}\`\\. Checked: 2026-11-16T08:30:00Z\\.`));
  } finally {
    repo.cleanup();
  }
});

test('a clean lock file of a release: no advisories, and a green status that names the release, its check time and run', async () => {
  const repo = repository({ '.': 'clean' });
  try {
    const result = await check({
      repository: repo.directory, commit: repo.commit, target: 'release v1.2.3', release: 'v1.2.3', exceptionsText: noExceptions, now,
      audit: recordedAudit({ 'package-lock.json': 'clean' }),
    });
    assert.deepEqual(result.open, []);
    assert.deepEqual(blocking(result), []);
    const run = 'https://github.com/example/project/actions/runs/42';
    assert.deepEqual(releaseStatus(result, run), {
      schema: 1, release: 'v1.2.3', commit: repo.commit, checked: '2026-11-16T08:30:00Z', run, high: 0, critical: 0,
    });
    const summary = renderSummary(result);
    assert.match(summary, /Release: v1\.2\.3\./);
    assert.match(summary, /### Open advisories\n\nNone\./);
    assert.throws(() => releaseStatus(result, 'https://example.com/actions/runs/42'), /Unexpected run URL/);
  } finally {
    repo.cleanup();
  }
});

test('excepted advisories leave the counts, keep their reason in the report, and stop applying after their review date', async () => {
  const repo = repository({ '.': 'vulnerable' });
  const exceptionsText = exceptionsFile(
    { advisory: 'GHSA-xvch-5gv4-984h', package: 'minimist', lockFile: 'package-lock.json', reason: 'Only a *test* tool | reads it', review: '2027-01-31' },
    { advisory: 'GHSA-35jh-r3h4-6jhm', package: 'lodash', lockFile: 'package-lock.json', reason: 'Expired one', review: '2026-11-15' },
    // An exception for another package does not cover the advisory where it reaches lodash.
    { advisory: 'GHSA-r5fr-rjxr-66jc', package: 'lodash-es', lockFile: 'package-lock.json', reason: 'Other package', review: '2027-01-31' },
  );
  try {
    const result = await check({
      repository: repo.directory, commit: 'HEAD', target: 'main', release: null, exceptionsText, now,
      audit: recordedAudit({ 'package-lock.json': 'vulnerable' }),
    });
    assert.deepEqual(result.counts, { critical: 0, high: 2, moderate: 2, low: 0, info: 0 });
    assert.deepEqual(result.excepted.map((advisory) => advisory.id), ['GHSA-xvch-5gv4-984h']);
    assert.deepEqual(result.expiredExceptions.map((exception) => exception.advisory), ['GHSA-35jh-r3h4-6jhm']);
    const summary = renderSummary(result);
    assert.match(summary, /\| minimist \(package\\-lock\\\.json\) \| Only a \\\*test\\\* tool \\\| reads it \| 2027-01-31 \|/);
    assert.match(summary, /GHSA-35jh-r3h4-6jhm for lodash \(package\\-lock\\\.json\), review was due 2026-11-15/);
  } finally {
    repo.cleanup();
  }
});

test('the exceptions on the review date itself still apply', () => {
  const { active, expired } = parseExceptions(exceptionsFile({ advisory: 'GHSA-xvch-5gv4-984h', package: 'minimist', lockFile: 'package-lock.json', reason: 'r', review: today }), today);
  assert.equal(active.length, 1);
  assert.equal(expired.length, 0);
});

test('a malformed exceptions file is refused, never read as no exceptions', () => {
  const entry = { advisory: 'GHSA-xvch-5gv4-984h', package: 'minimist', lockFile: 'package-lock.json', reason: 'r', review: '2027-01-31' };
  for (const [text, message] of [
    ['not json', /not valid JSON/],
    ['[]', /"exceptions" list/],
    [exceptionsFile({ ...entry, advisory: 'CVE-2021-44906' }), /GHSA id/],
    [exceptionsFile({ ...entry, package: '../x' }), /npm package name/],
    [exceptionsFile({ ...entry, reason: ' ' }), /"reason"/],
    [exceptionsFile({ ...entry, review: '2027-02-30' }), /"review" must be a date/],
    [exceptionsFile({ ...entry, expires: '2027-01-01' }), /unknown fields: expires/],
    [exceptionsFile({ ...entry, lockFile: '../package-lock.json' }), /"lockFile" must be the repository path/],
    [exceptionsFile({ ...entry, lockFile: 'yarn.lock' }), /"lockFile" must be the repository path/],
    [exceptionsFile({ ...entry, reason: 'x'.repeat(201) }), /at most 200 characters/],
    [exceptionsFile(entry, entry), /repeats GHSA-xvch-5gv4-984h for minimist in package-lock\.json/],
  ] as const) {
    assert.throws(() => parseExceptions(text, today), message, text);
  }
});

test('the repository exceptions file is valid', () => {
  // Validity only: an entry past its review date is reported by the scheduled scan, not by every pull request.
  const text = readFileSync(new URL(`../../${EXCEPTIONS_FILE}`, import.meta.url), 'utf8');
  const { active, expired } = parseExceptions(text, '2000-01-01');
  assert.equal(expired.length, 0, 'every entry has a review date');
  assert.ok(active.every((exception) => /package-lock\.json$/.test(exception.lockFile)));
});

test('an exception covers its package only in the lock file it names', () => {
  const advisory = (lockFile: string) => ({ lockFile, audit: { vulnerabilities: {
    glob: { via: [{ source: 1, name: 'glob', title: 'glob issue', url: 'https://github.com/advisories/GHSA-3g3m-2fjr-6pw4', severity: 'high', range: '*' }] },
  } } });
  const exceptions = parseExceptions(exceptionsFile({ advisory: 'GHSA-3g3m-2fjr-6pw4', package: 'glob', lockFile: 'test/harness/package-lock.json', reason: 'harness only', review: '2027-01-31' }), today);
  const input = { target: 'main', commit: 'a'.repeat(40), release: null, checked: '2026-11-16T00:00:00Z', exceptions };
  const harnessOnly = evaluate({ ...input, audits: [advisory('test/harness/package-lock.json')] });
  assert.deepEqual(harnessOnly.open, []);
  assert.match(renderSummary(harnessOnly), /\| glob \(test\\\/harness\\\/package\\-lock\\\.json\) \| harness only \|/);
  // The same advisory reaching the shipped lock file stays open, with every place it reaches.
  const both = evaluate({ ...input, audits: [advisory('test/harness/package-lock.json'), advisory('package-lock.json')] });
  assert.deepEqual(both.open.map((a) => a.packages.map((p) => p.lockFile)), [['package-lock.json', 'test/harness/package-lock.json']]);
  assert.deepEqual(both.excepted, []);
  assert.equal(blocking(both).length, 1);
});

test('an advisory reached through many packages and lock files counts once, at its highest severity', () => {
  // npm lists a package that is vulnerable only through another under `via` by name; only the advisory objects count.
  const bundled = {
    vulnerabilities: {
      npm: { severity: 'moderate', via: ['glob', 'minimatch'] },
      glob: { severity: 'moderate', via: [{ source: 1, name: 'glob', title: 'glob issue', url: 'https://github.com/advisories/GHSA-3g3m-2fjr-6pw4', severity: 'moderate', range: '<14.0.2' }, 'minimatch'] },
      minimatch: { severity: 'moderate', via: [{ source: 2, name: 'minimatch', title: 'ReDoS', url: 'https://github.com/advisories/GHSA-g3hv-75wg-m249', severity: 'moderate', range: '<11.0.1' }] },
    },
  };
  const elsewhere = {
    vulnerabilities: {
      minimatch: { severity: 'high', via: [{ source: 2, name: 'minimatch', title: 'ReDoS', url: 'https://github.com/advisories/GHSA-g3hv-75wg-m249', severity: 'high', range: '<11.0.1' }] },
      legacy: { severity: 'low', via: [{ source: 1099, name: 'legacy', title: 'Old advisory', url: 'https://www.npmjs.com/advisories/1099', severity: 'low', range: '*' }] },
    },
  };
  const result = evaluate({
    target: 'main', commit: 'a'.repeat(40), release: null, checked: '2026-11-16T00:00:00Z',
    audits: [{ lockFile: 'tools/package-lock.json', audit: bundled }, { lockFile: 'package-lock.json', audit: elsewhere }],
    exceptions: parseExceptions(exceptionsFile({ advisory: 'GHSA-3g3m-2fjr-6pw4', package: 'glob', lockFile: 'tools/package-lock.json', reason: 'bundled', review: '2027-01-31' }), today),
  });
  assert.deepEqual(result.counts, { critical: 0, high: 1, moderate: 0, low: 1, info: 0 });
  assert.deepEqual(result.open.map((advisory) => [advisory.id, advisory.severity, advisory.packages.map((p) => `${p.lockFile}:${p.name}`)]), [
    ['GHSA-g3hv-75wg-m249', 'high', ['package-lock.json:minimatch', 'tools/package-lock.json:minimatch']],
    ['npm-1099', 'low', ['package-lock.json:legacy']],
  ]);
  assert.deepEqual(result.excepted.map((advisory) => advisory.id), ['GHSA-3g3m-2fjr-6pw4']);
  assert.deepEqual(blocking(result).map((advisory) => advisory.id), ['GHSA-g3hv-75wg-m249']);
  // Only GitHub advisory pages are linked from the report.
  assert.match(renderSummary(result), /\| npm\\-1099 \| low \|/);
});

test('an audit that failed or returned something else is an error, never a clean result', () => {
  assert.throws(() => advisoriesOf({ error: { code: 'ENOTFOUND', summary: 'offline' } }, 'package-lock.json'), /npm audit failed for package-lock\.json/);
  assert.throws(() => advisoriesOf({}, 'package-lock.json'), /no vulnerability list/);
  assert.throws(() => advisoriesOf({ vulnerabilities: { x: { via: [{ name: 'x', severity: 'severe', url: 'https://github.com/advisories/GHSA-xvch-5gv4-984h' }] } } }, 'package-lock.json'), /known severity/);
  assert.throws(() => advisoriesOf({ vulnerabilities: { x: { via: [{ name: 'x', severity: 'high', url: 'https://example.com' }] } } }, 'package-lock.json'), /without an id/);
});

test('every tracked package-lock.json is checked, and nothing else', async () => {
  const repo = repository({ '.': 'clean', 'test/harness': 'vulnerable' });
  try {
    writeFileSync(join(repo.directory, 'lock.json'), '{}');
    assert.deepEqual(await lockFilesAt(repo.directory, repo.commit), ['package-lock.json', 'test/harness/package-lock.json']);
  } finally {
    repo.cleanup();
  }
});

test('a release is checked at the source its release commit records and is built on', async () => {
  const repo = repository({ '.': 'clean' });
  try {
    const commitTree = (manifest: object, parent: string) => {
      const blob = execFileSync('git', ['-C', repo.directory, 'hash-object', '-w', '--stdin'], { input: `${JSON.stringify(manifest)}\n`, encoding: 'utf8' }).trim();
      const tree = execFileSync('git', ['-C', repo.directory, 'mktree'], { input: `100644 blob ${blob}\trelease.json\n`, encoding: 'utf8' }).trim();
      return git(repo.directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit-tree', tree, '-p', parent, '-m', 'Release');
    };
    git(repo.directory, 'tag', 'v1.0.0', commitTree({ version: 'v1.0.0', source: repo.commit }, repo.commit));
    assert.equal(await releaseSource(repo.directory, 'v1.0.0'), repo.commit);

    // A release commit whose recorded source is not its parent is refused.
    const other = git(repo.directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit-tree', `${repo.commit}^{tree}`, '-m', 'other');
    git(repo.directory, 'tag', 'v1.0.1', commitTree({ version: 'v1.0.1', source: repo.commit }, other));
    await assert.rejects(releaseSource(repo.directory, 'v1.0.1'), /not built on its recorded source/);
    git(repo.directory, 'tag', 'v1.0.2', commitTree({ version: 'v1.0.1', source: repo.commit }, repo.commit));
    await assert.rejects(releaseSource(repo.directory, 'v1.0.2'), /does not name its version/);
    await assert.rejects(releaseSource(repo.directory, 'v1.0.0-rc.1'), /Only a final release/);
  } finally {
    repo.cleanup();
  }
});

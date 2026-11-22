// The release's pins step: it moves the workflow templates, the copy `init`
// embeds, the older releases and the configuration page to the release it
// just tagged, and pushes them on a branch cut from main. Run on the
// repository's own files, so a change to the templates or the page that the
// step could no longer rewrite fails here, before a release finds it.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { MINIMUM_RELEASE, OLDER_RELEASES, RELEASE_PIN } from '../../src/init/releases.ts';
import { CONFIGURATION_PAGE, EXAMPLES, INIT_TEMPLATES, OLDER_RELEASES as OLDER_RELEASES_FILE, pinBranch, pinFiles, pinRelease, pinnedRelease, type Release } from '../../src/release/pins.ts';

const root = resolve(import.meta.dirname, '../..');
// Versions no real release will take, so the test holds after the templates move to a newer one.
const BETWEEN: Release = { sha: 'b'.repeat(40), version: 'v999.0.0' };
const NEXT: Release = { sha: 'a'.repeat(40), version: 'v999.0.1' };

/** The repository's own files that the step reads, by path. */
async function repositoryFiles(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of (await readdir(join(root, EXAMPLES))).filter((file) => file.endsWith('.yml'))) files[`${EXAMPLES}/${name}`] = await readFile(join(root, EXAMPLES, name), 'utf8');
  for (const path of [INIT_TEMPLATES, OLDER_RELEASES_FILE, CONFIGURATION_PAGE]) files[path] = await readFile(join(root, path), 'utf8');
  return files;
}

/** Every release tag up to `NEXT`, oldest first, as the tags would list them. */
const tagsUpTo = (last: Release): Release[] => [
  ...Object.entries(OLDER_RELEASES).map(([sha, version]) => ({ sha, version })),
  MINIMUM_RELEASE,
  BETWEEN,
  ...(last === BETWEEN ? [] : [last]),
];

/** What the docs test reads: the oldest release init writes, named in the flag table and below it. */
function pageNames(page: string, version: string): boolean {
  const escaped = version.replaceAll('.', '\\.');
  return new RegExp(`\`${escaped}\` or a later release`).test(page) && new RegExp(`their examples pin,\\s+\`${escaped}\``).test(page);
}

test('the repository\'s templates pin one release, the one init reads as its oldest', async () => {
  const files = await repositoryFiles();
  const examples = Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith(`${EXAMPLES}/`)));
  assert.deepEqual(pinnedRelease(examples), MINIMUM_RELEASE);
  assert.ok(pageNames(files[CONFIGURATION_PAGE]!, MINIMUM_RELEASE.version));
});

test('moves every pin, the embedded templates, the older releases and the configuration page to the new release', async () => {
  const files = await repositoryFiles();
  const changed = pinFiles(files, NEXT, tagsUpTo(NEXT)).files ?? assert.fail('the templates kept their pin');
  const after = { ...files, ...changed };

  const examples = Object.keys(files).filter((path) => path.startsWith(`${EXAMPLES}/`));
  let pins = 0;
  for (const path of examples) {
    const text = after[path]!;
    for (const [, sha, version] of text.matchAll(new RegExp(RELEASE_PIN, 'g'))) {
      pins += 1;
      assert.deepEqual({ sha, version }, NEXT, path);
    }
    // Only the pins change.
    assert.equal(text.replace(new RegExp(RELEASE_PIN, 'g'), 'PIN'), files[path]!.replace(new RegExp(RELEASE_PIN, 'g'), 'PIN'), path);
  }
  assert.ok(pins >= 4, 'the sync and initial sync templates each pin two steps');

  const embedded = JSON.parse(after[INIT_TEMPLATES]!) as Record<string, string>;
  assert.deepEqual(Object.keys(embedded), Object.keys(JSON.parse(files[INIT_TEMPLATES]!) as object));
  for (const [name, text] of Object.entries(embedded)) assert.equal(text, after[`${EXAMPLES}/${name}`], `${INIT_TEMPLATES}: ${name}`);

  assert.deepEqual(JSON.parse(after[OLDER_RELEASES_FILE]!), {
    ...OLDER_RELEASES, [MINIMUM_RELEASE.sha]: MINIMUM_RELEASE.version, [BETWEEN.sha]: BETWEEN.version,
  });
  assert.ok(pageNames(after[CONFIGURATION_PAGE]!, NEXT.version), 'the configuration page names the new release');
  assert.ok(!pageNames(after[CONFIGURATION_PAGE]!, MINIMUM_RELEASE.version));
  // Only the two mentions of the page change.
  assert.equal(after[CONFIGURATION_PAGE]!.replaceAll(NEXT.version, 'X'), files[CONFIGURATION_PAGE]!.replace(/`v[^`]+` or a later release/, '`X` or a later release').replace(/(their examples pin,\s+)`[^`]+`/, '$1`X`'));

  // Run again on its own result, the step has nothing left to change.
  assert.deepEqual(pinFiles(after, NEXT, tagsUpTo(NEXT)), { kept: `The workflow templates on main already pin ${NEXT.version}.` });
});

test('refuses a tag that names another commit, templates that disagree and a page it cannot rewrite', async () => {
  const files = await repositoryFiles();
  assert.throws(() => pinFiles(files, { ...NEXT, sha: 'c'.repeat(40) }, tagsUpTo(NEXT)), /The tag v999\.0\.1 does not name c{40}/);
  assert.throws(() => pinFiles(files, NEXT, tagsUpTo(BETWEEN)), /does not name/, 'a release without its tag');
  assert.throws(() => pinFiles(files, { sha: 'A'.repeat(40), version: NEXT.version }, tagsUpTo(NEXT)), /full lowercase commit SHA/);

  const [first] = Object.keys(files).filter((path) => files[path]!.match(RELEASE_PIN));
  const split = { ...files, [first!]: files[first!]!.replace(RELEASE_PIN, `mdbisync/mdbisync@${BETWEEN.sha} # ${BETWEEN.version}`) };
  assert.throws(() => pinFiles(split, NEXT, tagsUpTo(NEXT)), /pin more than one release/);

  const reworded = { ...files, [CONFIGURATION_PAGE]: files[CONFIGURATION_PAGE]!.replace('or a later release', 'or newer') };
  assert.throws(() => pinFiles(reworded, NEXT, tagsUpTo(NEXT)), /names the oldest release 0 times/);
});

test('keeps the pin for a release older than the pinned one, and for a pre-release after a final release', async () => {
  const files = await repositoryFiles();
  const older = Object.entries(OLDER_RELEASES).map(([sha, version]) => ({ sha, version })).at(-1)!;
  assert.deepEqual(pinFiles(files, older, tagsUpTo(NEXT)), { kept: `The workflow templates on main pin ${MINIMUM_RELEASE.version}, which is not older than ${older.version}; they keep it.` });

  const final: Release = BETWEEN;
  const afterFinal = { ...files, ...pinFiles(files, final, tagsUpTo(BETWEEN)).files };
  assert.equal(pinnedRelease({ [`${EXAMPLES}/mdbisync.yml`]: afterFinal[`${EXAMPLES}/mdbisync.yml`]! }).version, final.version);
  const candidate: Release = { sha: 'd'.repeat(40), version: 'v999.0.1-rc.1' };
  assert.deepEqual(pinFiles(afterFinal, candidate, [...tagsUpTo(BETWEEN), candidate]), { kept: `The workflow templates on main pin the final release ${final.version}; the pre-release ${candidate.version} does not replace it.` });
  // The next final release moves them again.
  assert.ok(pinFiles(afterFinal, NEXT, [...tagsUpTo(BETWEEN), candidate, NEXT]).files);
});

/** A `main` on a bare origin with the repository's step files, pinned to a fixture release, and a release after it. */
async function fixture(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'release-pins-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const origin = join(base, 'origin.git');
  const seed = join(base, 'seed');
  const run = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '--quiet', '-b', 'main', seed]);
  for (const [key, value] of [['user.name', 'Release Test'], ['user.email', 'release@example.com'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) run(seed, 'config', key!, value!);
  // Two release commits, as on the releases branch; the templates pin the first.
  const releaseCommit = (version: string) => {
    const commit = run(seed, 'commit-tree', run(seed, 'hash-object', '-t', 'tree', '-w', '--stdin'), '-m', `Release ${version}`);
    run(seed, 'tag', '-a', version, commit, '-m', `Release ${version}`);
    return { sha: commit, version };
  };
  const first = releaseCommit('v0.1.0-rc.1');
  const second = releaseCommit('v0.1.0-rc.2');
  const files = await repositoryFiles();
  for (const [path, text] of Object.entries(files)) {
    const pinned = path === OLDER_RELEASES_FILE ? '{}\n'
      : text.replace(new RegExp(RELEASE_PIN, 'g'), `mdbisync/mdbisync@${first.sha} # ${first.version}`).replaceAll(`\`${MINIMUM_RELEASE.version}\``, `\`${first.version}\``);
    await mkdir(join(seed, path, '..'), { recursive: true });
    await writeFile(join(seed, path), pinned);
  }
  run(seed, 'add', '.');
  run(seed, 'commit', '--quiet', '-m', 'Templates pinned to rc.1');
  run(seed, 'remote', 'add', 'origin', origin);
  run(seed, 'push', '--quiet', 'origin', 'main', '--tags');
  /** A clone of main with every tag, as the pins job checks it out. */
  const clone = (name: string) => {
    const path = join(base, name);
    execFileSync('git', ['clone', '--quiet', origin, path]);
    for (const [key, value] of [['user.name', 'Release Test'], ['user.email', 'release@example.com'], ['commit.gpgsign', 'false']]) run(path, 'config', key!, value!);
    return path;
  };
  return { origin, run, first, second, clone, main: run(seed, 'rev-parse', 'HEAD') };
}

test('pushes the pins on a new branch from main and leaves main as it is', async (t) => {
  const { origin, run, first, second, clone, main } = await fixture(t);
  const { branch } = await pinRelease(clone('job'), second) as { branch: string };
  assert.equal(branch, pinBranch(second.version));
  assert.equal(branch, 'release-pins-v0.1.0-rc.2');
  assert.equal(run(origin, 'rev-parse', 'main'), main, 'main is not pushed');
  const pushed = run(origin, 'rev-parse', `refs/heads/${branch}`);
  assert.equal(run(origin, 'rev-parse', `${pushed}^`), main, 'one commit on main');
  assert.equal(run(origin, 'log', '-1', '--format=%s', pushed), 'Pin the workflow templates to v0.1.0-rc.2');
  const show = (path: string) => execFileSync('git', ['-C', origin, 'show', `${pushed}:${path}`], { encoding: 'utf8' });
  assert.ok(show(`${EXAMPLES}/mdbisync.yml`).includes(`mdbisync/mdbisync@${second.sha} # ${second.version}`));
  assert.ok(!show(`${EXAMPLES}/mdbisync.yml`).includes(first.sha));
  const embedded = JSON.parse(show(INIT_TEMPLATES)) as Record<string, string>;
  for (const [name, text] of Object.entries(embedded)) assert.equal(text, show(`${EXAMPLES}/${name}`), name);
  assert.deepEqual(JSON.parse(show(OLDER_RELEASES_FILE)), { [first.sha]: first.version });
  assert.ok(pageNames(show(CONFIGURATION_PAGE), second.version));
  assert.deepEqual(run(origin, 'diff', '--name-only', main, pushed).split('\n').sort(), [
    CONFIGURATION_PAGE, `${EXAMPLES}/mdbisync-initial-sync.yml`, `${EXAMPLES}/mdbisync.yml`, OLDER_RELEASES_FILE, INIT_TEMPLATES,
  ].sort());

  // A second run finds the branch of the first and is refused rather than moving it.
  const again = clone('again');
  await writeFile(join(again, 'note'), '');
  await assert.rejects(pinRelease(again, second), /local changes/);
  await rm(join(again, 'note'));
  await assert.rejects(pinRelease(again, second), /The branch release-pins-v0\.1\.0-rc\.2 already exists on origin/);
  assert.equal(run(origin, 'rev-parse', `refs/heads/${branch}`), pushed);
});

test('refuses a pins branch that already exists even where the push would fast-forward it, and only that branch', async (t) => {
  const { origin, run, second, clone, main } = await fixture(t);
  const branch = pinBranch(second.version);
  const job = clone('job');
  // A branch whose name only ends like it does not count.
  run(job, 'push', '--quiet', 'origin', `${main}:refs/heads/a/refs/heads/${branch}`);
  assert.deepEqual(await pinRelease(clone('tail'), second), { branch });
  run(origin, 'update-ref', `refs/heads/${branch}`, main);
  await assert.rejects(pinRelease(job, second), /already exists on origin/);
  assert.equal(run(origin, 'rev-parse', `refs/heads/${branch}`), main, 'the branch is not fast-forwarded');
});

test('pushes nothing when main already pins the release, and refuses a tag that names another commit', async (t) => {
  const { origin, first, second, clone, run } = await fixture(t);
  assert.deepEqual(await pinRelease(clone('same'), first), { kept: `The workflow templates on main already pin ${first.version}.` });
  await assert.rejects(pinRelease(clone('other'), { ...second, sha: first.sha }), /does not name/);
  assert.equal(run(origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/'), 'refs/heads/main');
});

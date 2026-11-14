import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GITHUB_API, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from '../state/index.ts';
import { checkExpectation, checksMissing, expectedChecks, headNote, headSince, mainVerdict, pastDeadline, readRedMainNote, redMainNote } from './deadline.ts';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

describe('the checks a head must pass', () => {
  const since = new Date('2026-11-10T11:00:00.000Z');
  const world = fakeWorld();
  world.github.checks = new Map([[OTHER, [
    { name: 'pre-commit', status: 'completed', conclusion: 'success' },
    { name: 'tests', status: 'in_progress' },
    { name: 'lint', status: 'completed', conclusion: 'failure', commitStatus: true },
  ]]]);
  const github = { repository: 'owner/repo', token: 'gh-token', apiUrl: GITHUB_API, fetch: fakeFetch(world) };
  /** A head GitHub knows checks for, with no history of its own on the branch. */
  const alone = { git: { text: async () => '' } as unknown as Git, base: 'f'.repeat(40), linear: 'f'.repeat(40) };

  it('notes the expected checks with the push time, and reads the same push time back', () => {
    const note = headNote(HEAD, since, ['ci / build', 'a -->b']);
    assert.equal(note.slice('<!--'.length, -'-->'.length).includes('>'), false);
    assert.equal(headSince(note, HEAD, new Date('2026-11-10T12:00:00.000Z')).toISOString(), since.toISOString());
    assert.equal(headNote(HEAD, since), `<!-- head: sha=${HEAD} since=${since.toISOString()} -->`);
  });

  it('expects the configured checks, the noted ones, and those of the noted head once the branch moved', async () => {
    assert.deepEqual(await expectedChecks(github, HEAD, ['tests'], { body: undefined, ...alone }), { names: ['tests'], observed: [], complete: true });
    const noted = `Text\n${headNote(OTHER, since, ['ci / build'])}\n`;
    // The same head: its own registered checks count anyway, so only the note's names are added.
    assert.deepEqual(await expectedChecks(github, OTHER, [], { body: noted, ...alone }), { names: ['ci / build'], observed: ['ci / build'], complete: true });
    // A moved branch: every check registered on the noted head, whatever its state, is expected on the new head.
    // The configured name is expected but never noted, so removing it from the configuration ends it.
    assert.deepEqual(await expectedChecks(github, HEAD, ['deploy'], { body: noted, ...alone }), { names: ['ci / build', 'deploy', 'lint', 'pre-commit', 'tests'], observed: ['ci / build', 'lint', 'pre-commit', 'tests'], complete: true });
  });

  // The description is editable text: a deleted note, or one naming the head itself, cannot drop the checks that ran on
  // the branch's earlier heads. They are read from the branch's history down to the sync's own commit.
  it('expects the checks of every commit since the sync\'s own, whatever the note says', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deadline-test-'));
    try {
      const git = new Git(root, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });
      await git.run(['init', '--quiet', '--bare']);
      const tree = await git.text(['hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' });
      const commit = async (message: string, ...parents: string[]) => git.text(['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', message]);
      const base = await commit('tracked');
      const linear = await commit('capture', base);
      const fix1 = await commit('fix 1', linear);
      const fix2 = await commit('fix 2', fix1);
      const merged = await commit('merge', fix2, base);
      const checks = new Map(world.github.checks);
      checks.set(linear, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }, { name: 'tests', status: 'completed', conclusion: 'failure' }]);
      checks.set(fix1, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
      checks.set(fix2, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
      const local = fakeWorld();
      local.github.checks = checks;
      const reader = { ...github, fetch: fakeFetch(local) };
      const branch = { git, base, linear };
      // Two formatter fixes in a row: `tests`, which ran on the sync's head below them, is expected on both.
      for (const body of [undefined, `Text\n${headNote(fix2, since)}\n`]) {
        assert.deepEqual(await expectedChecks(reader, fix2, [], { body, ...branch }), { names: ['pre-commit', 'tests'], observed: ['pre-commit', 'tests'], complete: true });
      }
      // A head the sync made itself expects only what the commit below it registered, as when it pushed it.
      assert.deepEqual(await expectedChecks(reader, merged, [], { body: undefined, ...branch }), { names: ['pre-commit'], observed: ['pre-commit'], complete: true });
      // A merge of a commit from neither the tracked branch nor Linear's state is no commit of the sync's: the walk goes on.
      const madeUp = await commit('made up');
      const forged = await commit('forged merge', fix2, madeUp);
      const fix3 = await commit('fix 3', forged);
      checks.set(forged, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
      checks.set(fix3, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
      assert.deepEqual(await expectedChecks(reader, fix3, [], { body: undefined, ...branch }), { names: ['pre-commit', 'tests'], observed: ['pre-commit', 'tests'], complete: true });
      // History longer than the search bound without a commit of the sync's own: the earlier checks are unknown.
      let tip = fix2;
      for (let index = 0; index < 50; index += 1) tip = await commit(`fix ${index + 3}`, tip);
      assert.equal((await expectedChecks(reader, tip, [], { body: undefined, ...branch })).complete, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('expects of a head the sync pushed what the commits it pushed on registered, not the older note', async () => {
    assert.deepEqual(await expectedChecks(github, HEAD, [], { pushedFrom: [OTHER] }), { names: ['lint', 'pre-commit', 'tests'], observed: ['lint', 'pre-commit', 'tests'], complete: true });
    assert.deepEqual(await expectedChecks(github, HEAD, ['deploy'], { pushedFrom: [] }), { names: ['deploy'], observed: [], complete: true });
  });

  it('ignores a noted head GitHub does not know and a name that does not decode', async () => {
    const unknown = 'c'.repeat(40);
    const failing = { ...github, fetch: async (input: string | URL | Request, init?: RequestInit) => String(input).includes(unknown) ? new Response('{"message":"No commit found"}', { status: 422 }) : github.fetch(input, init) };
    assert.deepEqual((await expectedChecks(failing, HEAD, [], { body: `<!-- head: sha=${unknown} since=${since.toISOString()} checks=%E0%A4%A,tests -->`, ...alone })).names, ['tests']);
  });

  it('tells a head that waits only for unregistered checks from one whose checks still run', () => {
    const strict = checkExpectation({}, ['tests']);
    assert.equal(strict.allowNone, false);
    assert.equal(checkExpectation({ mergeWithoutChecks: true }, []).allowNone, true);
    assert.equal(checksMissing({ state: 'pending', failed: [], pending: [], hasChecks: true, missing: ['tests'] }, strict), true);
    assert.equal(checksMissing({ state: 'pending', failed: [], pending: ['tests'], hasChecks: true }, strict), false);
    assert.equal(checksMissing({ state: 'pending', failed: [], pending: [], hasChecks: false }, strict), true);
    assert.equal(checksMissing({ state: 'passed', failed: [], pending: [], hasChecks: false }, { allowNone: true }), false);
  });
});

describe('the check deadline and red main', () => {
  it('reads the push time noted for the same head, and starts the clock for a new head or a missing note', () => {
    const now = new Date('2026-11-10T12:00:00.000Z');
    const since = new Date('2026-11-10T11:00:00.000Z');
    const body = `Changes.\n\n${headNote(HEAD, since)}\n`;
    assert.equal(headSince(body, HEAD, now).toISOString(), since.toISOString());
    assert.equal(headSince(body, OTHER, now), now);
    assert.equal(headSince('Changes.', HEAD, now), now);
    assert.equal(headSince(undefined, HEAD, now), now);
    assert.equal(headSince(body.replace(/\n/g, '\r\n'), HEAD, now).toISOString(), since.toISOString());
    // A note from the future (a clock that went back) starts the clock again instead of never ending it.
    assert.equal(headSince(headNote(HEAD, new Date('2026-11-11T00:00:00Z')), HEAD, now), now);
    assert.equal(headSince(`<!-- head: sha=${HEAD} since=2026-99-99T99:99:99Z -->`, HEAD, now), now);
  });

  it('is past the deadline from the full number of minutes on', () => {
    const since = new Date('2026-11-10T11:00:00.000Z');
    assert.equal(pastDeadline(since, 60, new Date('2026-11-10T11:59:59.999Z')), false);
    assert.equal(pastDeadline(since, 60, new Date('2026-11-10T12:00:00.000Z')), true);
    assert.equal(pastDeadline(since, 10, new Date('2026-11-10T11:10:00.000Z')), true);
  });

  it('round-trips the red-main note with check names that need encoding', () => {
    const hold = { head: HEAD, main: OTHER, checks: ['ci / build', 'lint,format', 'a -->b', 'c --!>d'] };
    const note = redMainNote(hold);
    // The encoded names hold no '>', so nothing inside the note can end the HTML comment.
    assert.equal(note.slice('<!--'.length, -'-->'.length).includes('>'), false);
    assert.deepEqual(readRedMainNote(`Text\n${note}\n`), hold);
    assert.equal(readRedMainNote('Text'), null);
    assert.equal(readRedMainNote(`<!-- red main: head=${HEAD} main=${OTHER} checks=%E0%A4%A -->`), null);
  });

  it('judges the tracked branch tip only by the names that did not pass on the head', () => {
    const base = { hasChecks: true, failed: [] as string[], pending: [] as string[] };
    const red = mainVerdict({ ...base, state: 'failed', failed: ['ci', 'docs'], failures: [{ name: 'ci', url: 'https://example.test/1' }, { name: 'docs' }] }, ['ci']);
    assert.deepEqual(red, { state: 'red', checks: [{ name: 'ci', url: 'https://example.test/1' }] });
    assert.deepEqual(mainVerdict({ ...base, state: 'failed', failed: ['docs'], failures: [{ name: 'docs' }] }, ['ci']), { state: 'clear', passed: false });
    assert.deepEqual(mainVerdict({ ...base, state: 'pending', pending: ['ci', 'docs'] }, ['ci', 'lint']), { state: 'pending', checks: ['ci'] });
    // A tip without the check (its CI not run or not registered yet) is clear, but not a pass.
    assert.deepEqual(mainVerdict({ ...base, state: 'passed' }, ['ci']), { state: 'clear', passed: false });
    assert.deepEqual(mainVerdict({ ...base, state: 'passed', succeeded: ['ci', 'docs'] }, ['ci']), { state: 'clear', passed: true });
    assert.deepEqual(mainVerdict({ ...base, state: 'passed', succeeded: ['ci'] }, ['ci', 'lint']), { state: 'clear', passed: false });
    // A failure on the tip wins over another of the names still running there.
    assert.equal(mainVerdict({ ...base, state: 'failed', failed: ['ci'], pending: ['lint'] }, ['ci', 'lint']).state, 'red');
  });
});

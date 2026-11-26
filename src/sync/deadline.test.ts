import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAKE_ACTIONS_APP_ID, FAKE_CI_ACCOUNT_ID, type FakeCheck, GITHUB_API, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { PullRequestError } from '../pull-request/github.ts';
import { readChecks } from '../pull-request/index.ts';
import { Git } from '../state/index.ts';
import { checkExpectation, checksMissing, type EarlierHeads, expectedChecks, type RequiredCheck, headNote, headSince, mainVerdict, pastDeadline, readRedMainNote, redMainNote } from './deadline.ts';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const ACTIONS = { kind: 'run', id: FAKE_ACTIONS_APP_ID } as const;
const RUN = { publisher: ACTIONS };
const CI_ACCOUNT = { kind: 'status', id: FAKE_CI_ACCOUNT_ID } as const;
/** Configured checks: a commit status of the repository's CI account. */
const TESTS = { name: 'tests', publisher: CI_ACCOUNT };
const DEPLOY = { name: 'deploy', publisher: CI_ACCOUNT };

describe('the checks a head must pass', () => {
  const since = new Date('2026-11-10T11:00:00.000Z');
  const world = fakeWorld();
  world.github.checks = new Map([[OTHER, [
    { name: 'pre-commit', status: 'completed', conclusion: 'success' },
    { name: 'tests', status: 'in_progress' },
    { name: 'lint', status: 'completed', conclusion: 'failure', commitStatus: true },
  ]]]);
  const github = { repository: 'owner/repo', token: 'gh-token', apiUrl: GITHUB_API, fetch: fakeFetch(world) };
  /** A head GitHub knows checks for, right above the head the sync recorded pushing, which registered none. */
  const PUSHED = 'e'.repeat(40);
  // A stand-in repository answers `git show` and `rev-list` from `text`; `plainMessages: false` sends commit messages there too.
  const alone = { git: { plainMessages: async () => false, text: async (args: string[]) => `${args[4]}\n${PUSHED}\n` } as unknown as Git, base: 'f'.repeat(40), pushed: PUSHED };

  it('notes the expected checks with the push time, and reads the same push time back', () => {
    const note = headNote(HEAD, since, [{ name: 'ci / build', publisher: ACTIONS }, { name: 'a -->b@run:1' }]);
    assert.equal(note.slice('<!--'.length, -'-->'.length).includes('>'), false);
    assert.match(note, new RegExp(` checks=ci%20%2F%20build@run:${FAKE_ACTIONS_APP_ID},a%20--%3Eb%40run%3A1 -->$`));
    assert.equal(headSince(note, HEAD, new Date('2026-11-10T12:00:00.000Z')).toISOString(), since.toISOString());
    assert.equal(headNote(HEAD, since), `<!-- head: sha=${HEAD} since=${since.toISOString()} -->`);
  });

  it('expects the configured checks, the noted ones, and those of the noted head once the branch moved', async () => {
    assert.deepEqual(await expectedChecks(github, HEAD, [TESTS], { body: undefined, ...alone }), { checks: [TESTS], observed: [], complete: true });
    const build = { name: 'ci / build', publisher: ACTIONS };
    const noted = `Text\n${headNote(OTHER, since, [build])}\n`;
    // The same head: its own registered checks count anyway, so only the note's checks are added, with their publishers.
    assert.deepEqual(await expectedChecks(github, OTHER, [], { body: noted, ...alone }), { checks: [build], observed: [build], complete: true });
    // A moved branch: every check registered on the noted head, whatever its state, is expected on the new head from
    // the publisher that registered it there. The configured check is expected from its configured publisher but never
    // noted, so removing it from the configuration ends it.
    const registered = [build, { name: 'lint', publisher: CI_ACCOUNT }, { name: 'pre-commit', ...RUN }, { name: 'tests', ...RUN }];
    assert.deepEqual(await expectedChecks(github, HEAD, [DEPLOY], { body: noted, ...alone }), { checks: [build, DEPLOY, ...registered.slice(1)], observed: registered, complete: true });
  });

  it('expects a check whose publisher GitHub did not name from that unknown publisher, never from anyone', async () => {
    const unnamed = { ...github, fetch: async (input: string | URL | Request, init?: RequestInit) => String(input).includes('/statuses?') ? Response.json([]) : github.fetch(input, init) };
    const { checks } = await expectedChecks(unnamed, HEAD, [], { pushedFrom: [OTHER] });
    assert.deepEqual(checks.find(({ name }) => name === 'lint'), { name: 'lint', publisher: { kind: 'status', id: 0 } });
    assert.match(headNote(HEAD, since, checks), /checks=lint@status:0,/);
  });

  it('expects a name registered by two publishers from each of them', async () => {
    const both = { ...github, fetch: fakeFetch({ ...world, github: { ...world.github, checks: new Map([[OTHER, [
      { name: 'tests', status: 'completed', conclusion: 'success' },
      { name: 'tests', status: 'completed', conclusion: 'success', commitStatus: true, creator: 666 },
    ]]]) } }) };
    assert.deepEqual((await expectedChecks(both, HEAD, [TESTS], { pushedFrom: [OTHER] })).checks, [
      { name: 'tests', ...RUN },
      TESTS,
      { name: 'tests', publisher: { kind: 'status', id: 666 } },
    ]);
  });

  // The description is editable text: a deleted note, or one naming the head itself, cannot drop the checks that ran on
  // the branch's earlier heads. They are read from the branch's history down to the head the sync recorded pushing.
  it('expects the checks of every commit since the sync\'s recorded head, whatever the note says', async () => {
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
      const branch = { git, base, pushed: linear };
      const formatter = { name: 'pre-commit', ...RUN };
      const both = [formatter, { name: 'tests', ...RUN }];
      // Two formatter fixes in a row: `tests`, which ran on the sync's head below them, is expected on both.
      for (const body of [undefined, `Text\n${headNote(fix2, since)}\n`]) {
        assert.deepEqual(await expectedChecks(reader, fix2, [], { body, ...branch }), { checks: both, observed: both, complete: true });
      }
      // A head the sync pushed itself expects only what the commit below it registered, as when it pushed it.
      assert.deepEqual(await expectedChecks(reader, merged, [], { body: undefined, ...branch, pushed: merged }), { checks: [formatter], observed: [formatter], complete: true });
      // A merge's parents are its author's choice: one of the tracked branch, of Linear's state or of anything else
      // that the sync did not record pushing does not end the walk.
      const madeUp = await commit('made up');
      for (const parent of [base, linear, madeUp]) {
        const forged = await commit('forged merge', fix2, parent);
        const fix3 = await commit('fix 3', forged);
        checks.set(fix3, [{ name: 'pre-commit', status: 'completed', conclusion: 'success' }]);
        assert.deepEqual(await expectedChecks(reader, fix3, [], { body: undefined, ...branch }), { checks: both, observed: both, complete: true });
      }
      // No recorded head, or one the branch's history no longer holds (the branch was rewritten): the earlier checks
      // are unknown.
      assert.equal((await expectedChecks(reader, fix2, [], { body: undefined, ...branch, pushed: undefined })).complete, false);
      const rewritten = await commit('rewritten', base);
      assert.equal((await expectedChecks(reader, await commit('fix', rewritten), [], { body: undefined, ...branch })).complete, false);
      // History longer than the search bound above the recorded head: the earlier checks are unknown.
      let tip = fix2;
      for (let index = 0; index < 50; index += 1) tip = await commit(`fix ${index + 3}`, tip);
      assert.equal((await expectedChecks(reader, tip, [], { body: undefined, ...branch })).complete, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('expects of a head the sync pushed what the commits it pushed on registered, not the older note', async () => {
    const registered = [{ name: 'lint', publisher: CI_ACCOUNT }, { name: 'pre-commit', ...RUN }, { name: 'tests', ...RUN }];
    assert.deepEqual(await expectedChecks(github, HEAD, [], { pushedFrom: [OTHER] }), { checks: registered, observed: registered, complete: true });
    assert.deepEqual(await expectedChecks(github, HEAD, [DEPLOY], { pushedFrom: [] }), { checks: [DEPLOY], observed: [], complete: true });
  });

  it('expects an earlier head\'s Actions check by name and publisher, so the same job on a later head meets it', async () => {
    // A job that ran on an earlier head, then the pull request moved on: whoever pushed the later head, the job of
    // the same name from the Actions App on it meets the earlier expectation, and its absence keeps the head waiting.
    const local = fakeWorld();
    local.github.checks = new Map([
      [OTHER, [{ name: 'tests', status: 'completed', conclusion: 'success' }]],
      [HEAD, [{ name: 'tests', status: 'completed', conclusion: 'success' }]],
    ]);
    const repo = { ...github, fetch: fakeFetch(local) };
    const history = { git: { plainMessages: async () => false, text: async () => `${HEAD}\n${OTHER}` } as unknown as Git, base: 'f'.repeat(40) };
    for (const earlier of [{ pushedFrom: [OTHER] }, { body: undefined, ...history, pushed: OTHER }, { body: undefined, ...history, pushed: HEAD }] as EarlierHeads[]) {
      const expected = await expectedChecks(repo, HEAD, [], earlier);
      assert.deepEqual(expected.checks, [{ name: 'tests', ...RUN }]);
      assert.equal((await readChecks(repo, HEAD, checkExpectation({}, expected.checks))).state, 'passed');
    }
    local.github.checks.set(HEAD, [{ name: 'tests', status: 'completed', conclusion: 'success', app: 77 }]);
    const moved = await expectedChecks(repo, HEAD, [], { body: undefined, ...history, pushed: OTHER });
    assert.deepEqual((await readChecks(repo, HEAD, checkExpectation({}, moved.checks))).missing, ['tests'], 'another App met an Actions check');
  });

  it('reads a check noted with a workflow identity by an earlier version by its name and publisher', async () => {
    const local = fakeWorld();
    local.github.checks = new Map([[HEAD, [{ name: 'tests', status: 'completed', conclusion: 'success' }]]]);
    const repo = { ...github, fetch: fakeFetch(local) };
    const identity = encodeURIComponent(JSON.stringify({ path: '.github/workflows/ci.yml', revision: 'b'.repeat(40), event: 'pull_request' }));
    // Another GitHub server's Actions App id, noted by an earlier version, reads as the Actions App.
    for (const id of [FAKE_ACTIONS_APP_ID, 999]) {
      const legacy = `<!-- head: sha=${HEAD} since=${since.toISOString()} checks=tests@run:${id}~${identity} -->`;
      const read = await expectedChecks(repo, HEAD, [], { body: legacy, git: { plainMessages: async () => false, text: async () => `${HEAD}\n` } as unknown as Git, base: 'f'.repeat(40), pushed: HEAD });
      assert.deepEqual(read.checks, [{ name: 'tests', ...RUN }]);
    }
    const body = `<!-- head: sha=${HEAD} since=${since.toISOString()} checks=tests@run:${FAKE_ACTIONS_APP_ID}~${identity} -->`;
    const expected = await expectedChecks(repo, HEAD, [], { body, git: { plainMessages: async () => false, text: async () => `${HEAD}\n` } as unknown as Git, base: 'f'.repeat(40), pushed: HEAD });
    assert.deepEqual(expected.checks, [{ name: 'tests', ...RUN }]);
    assert.equal(headNote(HEAD, since, expected.checks), `<!-- head: sha=${HEAD} since=${since.toISOString()} checks=tests@run:${FAKE_ACTIONS_APP_ID} -->`);
  });

  // A new branch has no earlier heads: a configured check is met only by its configured publisher, never by its name.
  it('meets a configured check only from its configured publisher', async () => {
    const state = async (registered: FakeCheck[], required: RequiredCheck[]) => {
      const local = fakeWorld();
      local.github.checks = new Map([[HEAD, registered]]);
      const repo = { ...github, fetch: fakeFetch(local) };
      // A head the sync pushes in this run, and one it pushed in an earlier run, with no earlier heads below either.
      const earlier: EarlierHeads[] = [{ pushedFrom: [] }, { body: undefined, git: { plainMessages: async () => false, text: async () => `${HEAD}\n` } as unknown as Git, base: 'f'.repeat(40), pushed: HEAD }];
      const [now, later] = await Promise.all(earlier.map(async (heads) => (await readChecks(repo, HEAD, checkExpectation({}, (await expectedChecks(repo, HEAD, required, heads)).checks))).state));
      assert.equal(now, later, 'a new head and the same head in a later run disagreed');
      return now;
    };
    const passed = { name: 'tests', status: 'completed', conclusion: 'success' } as const;
    // A GitHub Actions job: a check run of the Actions App, not a commit status or another App's check run.
    const actions = [{ name: 'tests', publisher: ACTIONS }];
    assert.equal(await state([passed], actions), 'passed');
    assert.equal(await state([{ ...passed, commitStatus: true }], actions), 'pending');
    assert.equal(await state([{ ...passed, app: 77 }], actions), 'pending');
    // Another App's check run, or a status from another account.
    const app = [{ name: 'tests', publisher: { kind: 'run' as const, id: 77 } }];
    assert.equal(await state([{ ...passed, app: 77 }], app), 'passed');
    assert.equal(await state([{ ...passed, app: 78 }], app), 'pending');
    assert.equal(await state([{ ...passed, commitStatus: true, creator: 77 }], app), 'pending');
    assert.equal(await state([passed], app), 'pending');
    const status = [{ name: 'tests', publisher: CI_ACCOUNT }];
    assert.equal(await state([{ ...passed, commitStatus: true }], status), 'passed');
    assert.equal(await state([{ ...passed, commitStatus: true, creator: 666 }], status), 'pending');
    // A later status from another account replaces the configured account's failure in the combined status: still unmet.
    assert.equal(await state([{ ...passed, commitStatus: true, creator: 666, history: [{ state: 'failure', creator: FAKE_CI_ACCOUNT_ID }] }], status), 'pending');
  });

  it('ignores a noted head GitHub does not know, a name that does not decode and a malformed publisher', async () => {
    const unknown = 'c'.repeat(40);
    const failing = { ...github, fetch: async (input: string | URL | Request, init?: RequestInit) => String(input).includes(unknown) ? new Response('{"message":"No commit found"}', { status: 422 }) : github.fetch(input, init) };
    const body = `<!-- head: sha=${unknown} since=${since.toISOString()} checks=%E0%A4%A,lint@app:3,lint@run:01,lint@run:-1,pre-commit@run:0,tests,tests@status:42 -->`;
    assert.deepEqual((await expectedChecks(failing, HEAD, [], { body, ...alone })).checks, [{ name: 'pre-commit', publisher: { kind: 'run', id: 0 } }, { name: 'tests' }, { name: 'tests', publisher: { kind: 'status', id: 42 } }]);
  });

  it('never drops earlier check expectations when status reads return not found', async () => {
    for (const status of [404, 422]) {
      const repo = { ...github, fetch: async (input: string | URL | Request, init?: RequestInit) =>
        String(input).includes('/statuses?') ? Response.json({}, { status }) : github.fetch(input, init) };
      await assert.rejects(expectedChecks(repo, HEAD, [], { pushedFrom: [OTHER] }),
        (error: unknown) => error instanceof PullRequestError && error.status === status);
    }
  });

  it('tells a head that waits only for unregistered checks from one whose checks still run', () => {
    const strict = checkExpectation({}, [{ name: 'tests' }]);
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

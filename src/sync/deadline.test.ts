import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FAKE_ACTIONS_APP_ID, FAKE_CI_ACCOUNT_ID, GITHUB_API, fakeFetch, fakeWorld } from '../setup/test-helpers.ts';
import { checkExpectation, checksMissing, expectedChecks, headNote, headSince, mainVerdict, pastDeadline, readRedMainNote, redMainNote } from './deadline.ts';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const ACTIONS = { kind: 'run', id: FAKE_ACTIONS_APP_ID } as const;
const CI_ACCOUNT = { kind: 'status', id: FAKE_CI_ACCOUNT_ID } as const;

describe('the checks a head must pass', () => {
  const since = new Date('2026-11-10T11:00:00.000Z');
  const world = fakeWorld();
  world.github.checks = new Map([[OTHER, [
    { name: 'pre-commit', status: 'completed', conclusion: 'success' },
    { name: 'tests', status: 'in_progress' },
    { name: 'lint', status: 'completed', conclusion: 'failure', commitStatus: true },
  ]]]);
  const github = { repository: 'owner/repo', token: 'gh-token', apiUrl: GITHUB_API, fetch: fakeFetch(world) };

  it('notes the expected checks with the push time, and reads the same push time back', () => {
    const note = headNote(HEAD, since, [{ name: 'ci / build', publisher: ACTIONS }, { name: 'a -->b@run:1' }]);
    assert.equal(note.slice('<!--'.length, -'-->'.length).includes('>'), false);
    assert.match(note, new RegExp(` checks=ci%20%2F%20build@run:${FAKE_ACTIONS_APP_ID},a%20--%3Eb%40run%3A1 -->$`));
    assert.equal(headSince(note, HEAD, new Date('2026-11-10T12:00:00.000Z')).toISOString(), since.toISOString());
    assert.equal(headNote(HEAD, since), `<!-- head: sha=${HEAD} since=${since.toISOString()} -->`);
  });

  it('expects the configured checks, the noted ones, and those of the noted head once the branch moved', async () => {
    assert.deepEqual(await expectedChecks(github, HEAD, ['tests'], { body: undefined }), { checks: [{ name: 'tests' }], observed: [] });
    const build = { name: 'ci / build', publisher: ACTIONS };
    const noted = `Text\n${headNote(OTHER, since, [build])}\n`;
    // The same head: its own registered checks count anyway, so only the note's checks are added, with their publishers.
    assert.deepEqual(await expectedChecks(github, OTHER, [], { body: noted }), { checks: [build], observed: [build] });
    // A moved branch: every check registered on the noted head, whatever its state, is expected on the new head from
    // the publisher that registered it there. The configured name is expected from any publisher but never noted, so
    // removing it from the configuration ends it.
    const registered = [build, { name: 'lint', publisher: CI_ACCOUNT }, { name: 'pre-commit', publisher: ACTIONS }, { name: 'tests', publisher: ACTIONS }];
    assert.deepEqual(await expectedChecks(github, HEAD, ['deploy'], { body: noted }), { checks: [build, { name: 'deploy' }, ...registered.slice(1)], observed: registered });
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
    assert.deepEqual((await expectedChecks(both, HEAD, ['tests'], { pushedFrom: [OTHER] })).checks, [
      { name: 'tests' },
      { name: 'tests', publisher: ACTIONS },
      { name: 'tests', publisher: { kind: 'status', id: 666 } },
    ]);
  });

  it('expects of a head the sync pushed what the commits it pushed on registered, not the older note', async () => {
    const registered = [{ name: 'lint', publisher: CI_ACCOUNT }, { name: 'pre-commit', publisher: ACTIONS }, { name: 'tests', publisher: ACTIONS }];
    assert.deepEqual(await expectedChecks(github, HEAD, [], { pushedFrom: [OTHER] }), { checks: registered, observed: registered });
    assert.deepEqual(await expectedChecks(github, HEAD, ['deploy'], { pushedFrom: [] }), { checks: [{ name: 'deploy' }], observed: [] });
  });

  it('ignores a noted head GitHub does not know, a name that does not decode and a malformed publisher', async () => {
    const unknown = 'c'.repeat(40);
    const failing = { ...github, fetch: async (input: string | URL | Request, init?: RequestInit) => String(input).includes(unknown) ? new Response('{"message":"No commit found"}', { status: 422 }) : github.fetch(input, init) };
    const body = `<!-- head: sha=${unknown} since=${since.toISOString()} checks=%E0%A4%A,lint@app:3,lint@run:01,lint@run:-1,pre-commit@run:0,tests,tests@status:42 -->`;
    assert.deepEqual((await expectedChecks(failing, HEAD, [], { body })).checks, [{ name: 'pre-commit', publisher: { kind: 'run', id: 0 } }, { name: 'tests' }, { name: 'tests', publisher: { kind: 'status', id: 42 } }]);
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

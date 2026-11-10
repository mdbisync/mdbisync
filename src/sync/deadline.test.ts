import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { headNote, headSince, mainVerdict, pastDeadline, readRedMainNote, redMainNote } from './deadline.ts';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

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
    const hold = { head: HEAD, main: OTHER, checks: ['ci / build', 'lint,format', 'a -->b'] };
    const note = redMainNote(hold);
    assert.doesNotMatch(note.slice(4, -4), /-->/);
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

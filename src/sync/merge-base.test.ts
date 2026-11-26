// The base of the sync's merge when git's history has more than one merge
// base: the same change reaches the `linear` ref and the tracked branch by
// different merges (a criss-cross). git merges such bases into one; the
// sync's merge must take that merged base, also when a suspended or
// released path makes it name the base itself.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Git, commitTree, type IdEntry, type IdMap, type Oid } from '../state/index.ts';
import { type Fixture, IDENTITY, createFixture } from '../state/test-helpers.ts';
import { mergeLocally, mergeWithMarkers } from './merge.ts';

const TREE: Record<string, string> = {
  'eng/README.md': '---\nlinear-team: ENG\n---\n',
  'eng/plan.md': '# Plan\n\n- Order the parts\n- Book the room\n',
  'eng/held.md': '# Held\n\nWaiting for review.\n',
  'eng/other.md': '# Other\n\nFirst draft.\n',
};

const FIRST_EDIT = '# Plan\n\n- Order the parts by Friday\n- Book the room\n';
const SECOND_EDIT = '# Plan\n\n- Order the parts by Friday\n  - Ask for two quotes\n- Book the room\n';

const EPISODE = { noticeId: 'notice-1', paths: [], checks: [] };

describe('sync: the merge base of a criss-cross history', () => {
  let fixture: Fixture;
  let git: Git;
  let seed: Oid;
  let tick = 0;

  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.seed(TREE);
    git = await fixture.clone('engine');
    await git.run(['fetch', '--quiet', 'origin', 'main']);
    seed = await git.revParse('FETCH_HEAD');
    tick = 0;
  });
  afterEach(() => fixture.cleanup());

  /** A commit with a later time than the one before, so git's choice among equal bases is stable. */
  const commit = async (parents: Oid[], changes: Record<string, string>, message: string): Promise<Oid> => {
    tick += 1;
    const date = `${1_800_000_000 + tick * 60} +0000`;
    const timed = new Git(git.dir, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    return commitTree(timed, { parents, base: parents[0] as Oid, changes: new Map(Object.entries(changes)), message, identity: IDENTITY, skipIfUnchanged: false });
  };

  /**
   * The history of the report: the tracked branch moves on (an earlier pull
   * request) while a capture records the first edit on `linear`; `linear`
   * takes in the tracked branch, the tracked branch takes in the capture,
   * and a second capture adds a line under the edited one.
   */
  async function crissCross(): Promise<{ linear: Oid; tracked: Oid }> {
    const capture = await commit([seed], { 'eng/plan.md': FIRST_EDIT }, 'Capture the first edit');
    const trackedBefore = await commit([seed], { 'eng/other.md': '# Other\n\nSecond draft.\n' }, 'Earlier pull request');
    const linearMerge = await commit([capture, trackedBefore], { 'eng/other.md': '# Other\n\nSecond draft.\n' }, 'Take in the tracked branch');
    const tracked = await commit([trackedBefore, capture], { 'eng/plan.md': FIRST_EDIT }, 'Merge the sync pull request');
    const linear = await commit([linearMerge], { 'eng/plan.md': SECOND_EDIT }, 'Capture the second edit');
    const bases = (await git.text(['merge-base', '--all', linear, tracked])).split('\n').filter(Boolean);
    assert.equal(bases.length, 2, 'the history must have two merge bases');
    return { linear, tracked };
  }

  const ids = (extra: Record<string, Partial<IdEntry>> = {}): IdMap => new Map([
    ['eng/plan.md', { id: 'doc-plan', ...extra['eng/plan.md'] }],
    ['eng/held.md', { id: 'doc-held', ...extra['eng/held.md'] }],
    ['eng/other.md', { id: 'doc-other', ...extra['eng/other.md'] }],
  ]);

  const planOf = async (tree: Oid) => (await git.run(['cat-file', 'blob', `${tree}:eng/plan.md`])).stdout.toString('utf8');

  it('takes a line Linear added next to a change both sides hold, with a suspended path elsewhere', async () => {
    const { linear, tracked } = await crissCross();
    const merged = await mergeLocally(git, linear, tracked, ids({ 'eng/held.md': { suspended: EPISODE } }));
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(merged.marked, []);
    assert.equal(await planOf(merged.tree), SECOND_EDIT);
    assert.deepEqual(merged.changes.filter((change) => change.kind !== 'create'), []);
    // A run that repeats the merge gets the same base, so ids derived from it hold.
    const again = await mergeLocally(git, linear, tracked, ids({ 'eng/held.md': { suspended: EPISODE } }));
    assert.equal(again.base, merged.base);
  });

  it('takes the same line without a suspended path', async () => {
    const { linear, tracked } = await crissCross();
    const merged = await mergeLocally(git, linear, tracked, ids());
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(merged.marked, []);
    assert.equal(await planOf(merged.tree), SECOND_EDIT);
  });

  it('takes the same line with a released path elsewhere', async () => {
    const { linear, tracked } = await crissCross();
    const merged = await mergeLocally(git, linear, tracked, ids({ 'eng/held.md': { releaseBase: seed, releasePaths: ['eng/held.md'] } }));
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(merged.marked, []);
    assert.equal(await planOf(merged.tree), SECOND_EDIT);
  });

  it('still marks a line both sides changed differently, with and without a suspended path', async () => {
    const { linear, tracked } = await crissCross();
    const edited = await commit([tracked], { 'eng/plan.md': '# Plan\n\n- Order the parts by Monday\n- Book the room\n' }, 'Change the edited line again');
    for (const extra of [{ 'eng/held.md': { suspended: EPISODE } }, {}]) {
      const merged = await mergeLocally(git, linear, edited, ids(extra));
      assert.deepEqual(merged.marked, ['eng/plan.md']);
      const text = await planOf(merged.tree);
      assert.match(text, /by Monday/);
      assert.match(text, /by Friday/);
      // The first edit is in both sides' history: only the line changed since is in conflict.
      assert.doesNotMatch(text, /- Order the parts\n/);
    }
  });

  it('merges bases that share no history over an empty tree, as git does', async () => {
    // Two unrelated histories joined on both sides by different merges: their roots are the merge bases.
    const other = await commitTree(git, { parents: [], base: null, changes: new Map([['eng/extra.md', '# Extra\n\nKept apart.\n']]), message: 'Unrelated history', identity: IDENTITY });
    const left = await commit([seed, other], { 'eng/extra.md': '# Extra\n\nKept apart.\n' }, 'Join the histories');
    const right = await commit([other, seed], { 'eng/README.md': TREE['eng/README.md'] as string, 'eng/plan.md': TREE['eng/plan.md'] as string, 'eng/held.md': TREE['eng/held.md'] as string, 'eng/other.md': TREE['eng/other.md'] as string }, 'Join them the other way');
    const linear = await commit([left], { 'eng/plan.md': FIRST_EDIT }, 'Capture an edit');
    const bases = (await git.text(['merge-base', '--all', linear, right])).split('\n').filter(Boolean);
    assert.equal(bases.length, 2);
    const merged = await mergeLocally(git, linear, right, ids({ 'eng/held.md': { suspended: EPISODE } }));
    assert.deepEqual(merged.conflicts, []);
    assert.equal(await planOf(merged.tree), FIRST_EDIT);
  });

  it('keeps an edit Linear holds when the merge bases disagree on deleting its document', async () => {
    // One base edits the plan, the other deletes it: git's merge of the bases keeps the older plan, so
    // Linear's edit against it meets the tracked branch's delete, and the edit wins.
    const edited = await commit([seed], { 'eng/plan.md': FIRST_EDIT }, 'Edit the plan');
    const deleted = await commitTree(git, { parents: [seed], base: seed, changes: new Map([['eng/plan.md', null]]), message: 'Delete the plan', identity: IDENTITY });
    const linear = await commit([edited, deleted], { 'eng/plan.md': FIRST_EDIT }, 'Keep the edit');
    const tracked = await commitTree(git, { parents: [deleted, edited], base: deleted, changes: new Map(), message: 'Keep the delete', identity: IDENTITY, skipIfUnchanged: false });
    for (const extra of [{ 'eng/held.md': { suspended: EPISODE } }, {}]) {
      const merged = await mergeLocally(git, linear, tracked, ids(extra));
      assert.ok(!merged.changes.some((change) => change.kind === 'trash' && change.id === 'doc-plan'), JSON.stringify(merged.changes));
      assert.equal(await planOf(merged.tree), FIRST_EDIT);
    }
  });

  it('leaves out a file the merge bases renamed to different names, as git does', async () => {
    // The bases rename the plan two ways; Linear removes both copies, the tracked branch keeps them and adds the
    // plan back. git's merge of the bases holds neither the plan nor a reason to delete it: the plan stays.
    const toA = await commitTree(git, { parents: [seed], base: seed, changes: new Map([['eng/plan.md', null], ['eng/plan-a.md', TREE['eng/plan.md'] as string]]), message: 'Rename the plan one way', identity: IDENTITY });
    const toB = await commitTree(git, { parents: [seed], base: seed, changes: new Map([['eng/plan.md', null], ['eng/plan-b.md', TREE['eng/plan.md'] as string]]), message: 'Rename it the other way', identity: IDENTITY });
    const linear = await commitTree(git, { parents: [toA, toB], base: toA, changes: new Map([['eng/plan-a.md', null]]), message: 'Remove both copies', identity: IDENTITY, skipIfUnchanged: false });
    const tracked = await commitTree(git, { parents: [toB, toA], base: toB, changes: new Map([['eng/plan-a.md', TREE['eng/plan.md'] as string], ['eng/plan.md', TREE['eng/plan.md'] as string]]), message: 'Keep both and add the plan back', identity: IDENTITY });
    const held = new Map([['eng/held.md', { id: 'doc-held', suspended: EPISODE }], ['eng/other.md', { id: 'doc-other' }]]);
    const merged = await mergeLocally(git, linear, tracked, held);
    assert.equal(await planOf(merged.tree), TREE['eng/plan.md']);
  });

  it('gives the structural rules the merged base when git cannot merge a document', async () => {
    const { linear, tracked } = await crissCross();
    const edited = await commit([tracked], { 'eng/plan.md': '# Plan\n\n- Order the parts by Monday\n- Book the room\n' }, 'Change the edited line again');
    const { base } = await mergeWithMarkers(git, linear, edited, ids());
    assert.equal(await planOf(base), FIRST_EDIT);
  });
});

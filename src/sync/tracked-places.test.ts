import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type Fixture, createFixture, IDENTITY } from '../state/test-helpers.ts';
import { type Git, type Oid, commitTree } from '../state/index.ts';
import { type Place, loadMapping } from '../mapping/index.ts';
import { pendingMove, recordsUnmergedMove, syncedPlaces } from './tracked-places.ts';
import { LINEAR_FACTS } from '../linear/index.ts';
import { MAPPING_FILE_BYTES } from '../mapping/blobs.ts';
import { MERGE_RECORD_MESSAGE } from './write.ts';

const team = (name: string) => `---\nlinear-team: ${name}\n---\n\n# Folder\n`;
const project = (name: string, teamName?: string) => `---\n${teamName === undefined ? '' : `linear-team: ${teamName}\n`}linear-project: ${name}\n---\n\n# Folder\n`;
const inProject = (teamName: string, name: string): Place => ({ kind: 'project', team: teamName, project: name });
const inTeam = (teamName: string): Place => ({ kind: 'team', team: teamName });

describe('places the tracked branch named', () => {
  let fixture: Fixture;
  let git: Git;
  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.seed({ 'notes.md': 'Notes.\n' });
    git = await fixture.clone('places');
  });
  afterEach(() => fixture.cleanup());

  const commit = (parents: Oid[], changes: Record<string, string | null>) =>
    commitTree(git, { parents, base: parents[0] ?? null, changes: new Map(Object.entries(changes)), message: 'Change', identity: IDENTITY, skipIfUnchanged: false });
  const check = (tracked: Oid, path: string, place: Place) => syncedPlaces(git, tracked, new Map(), new Map(), LINEAR_FACTS)(path, place);
  const record = (parents: Oid[], changes: Record<string, string | null>) =>
    commitTree(git, { parents, base: parents[0] ?? null, changes: new Map(Object.entries(changes)), message: MERGE_RECORD_MESSAGE, identity: IDENTITY, skipIfUnchanged: false });

  it('allows the place of the newest synchronized version and the moves while it lasted', async () => {
    const first = await commit([], { 'docs/README.md': project('First', 'ENG'), 'docs/page.md': 'Page.\n' });
    const second = await commit([first], { 'docs/README.md': project('Second', 'ENG') });
    const third = await commit([second], { 'docs/README.md': project('Third', 'ENG') });
    for (const name of ['First', 'Second', 'Third']) assert.equal(await check(third, 'docs/page.md', inProject('ENG', name)), true, name);
    assert.equal(await check(third, 'docs/page.md', inTeam('ENG')), false, 'never the place of docs/');
  });

  it('refuses a place the folder held only before the newest synchronized version', async () => {
    const first = await commit([], { 'docs/README.md': project('First', 'ENG'), 'docs/page.md': 'Page.\n' });
    const second = await commit([first], { 'docs/README.md': project('Second', 'ENG') });
    const edited = await commit([second], { 'docs/page.md': 'Page, edited.\n' });
    const third = await commit([edited], { 'docs/README.md': project('Third', 'ENG') });
    assert.equal(await check(third, 'docs/page.md', inProject('ENG', 'First')), false, 'a place before the previous move');
    assert.equal(await check(third, 'docs/page.md', inProject('ENG', 'Second')), true);
    assert.equal(await check(third, 'docs/page.md', inProject('ENG', 'Third')), true);
  });

  it('keeps the places of a file left out since before a move, and refuses the places after it', async () => {
    const first = await commit([], { 'docs/README.md': project('First', 'ENG'), 'docs/page.md': 'Page.\n' });
    const second = await commit([first], { 'docs/README.md': project('Second', 'ENG') });
    const leftOut = await commit([second], { 'docs/page.md': 'Page.\n\n![Image](missing.png)\n' });
    const third = await commit([leftOut], { 'docs/README.md': project('Third', 'ENG') });
    const fourth = await commit([third], { 'docs/README.md': project('Fourth', 'ENG') });
    // The version synchronized in First lasted through the move to Second: either is where the sync last gave it.
    assert.equal(await check(fourth, 'docs/page.md', inProject('ENG', 'First')), true);
    assert.equal(await check(fourth, 'docs/page.md', inProject('ENG', 'Second')), true);
    assert.equal(await check(fourth, 'docs/page.md', inProject('ENG', 'Third')), false, 'the file was left out when the folder moved there');
    assert.equal(await check(fourth, 'docs/page.md', inProject('ENG', 'Fourth')), false);
  });

  it('keeps the place of a version left out with a move after the branch fixed the file, and no older place', async () => {
    const first = await commit([], { 'docs/README.md': project('First', 'ENG'), 'docs/page.md': 'Page.\n' });
    const second = await commit([first], { 'docs/README.md': project('Second', 'ENG'), 'docs/page.md': 'Page, edited.\n' });
    const leftOut = await commit([second], { 'docs/README.md': project('Third', 'ENG'), 'docs/page.md': 'Page.\n\n![Image](missing.png)\n' });
    const fixed = await commit([leftOut], { 'docs/page.md': 'Page, fixed.\n' });
    assert.equal(await check(fixed, 'docs/page.md', inProject('ENG', 'Second')), true, 'the sync has not written the fix yet');
    assert.equal(await check(fixed, 'docs/page.md', inProject('ENG', 'Third')), true);
    assert.equal(await check(fixed, 'docs/page.md', inProject('ENG', 'First')), false, 'a place before the version the fix replaces');
    const again = await commit([fixed], { 'docs/page.md': 'Page, fixed again.\n' });
    assert.equal(await check(again, 'docs/page.md', inProject('ENG', 'Second')), true, 'two fixes before the next sync');
    assert.equal(await check(again, 'docs/page.md', inProject('ENG', 'First')), false);
  });

  it('refuses the places of an older cycle of leaving a file out and fixing it', async () => {
    const first = await commit([], { 'docs/README.md': project('First', 'ENG'), 'docs/page.md': 'Page.\n' });
    const leftOut = await commit([first], { 'docs/page.md': 'Page.\n\n![Image](missing.png)\n' });
    const fixed = await commit([leftOut], { 'docs/README.md': project('Second', 'ENG'), 'docs/page.md': 'Page, fixed.\n' });
    const again = await commit([fixed], { 'docs/page.md': 'Page, fixed.\n\n![Image](missing.png)\n' });
    const third = await commit([again], { 'docs/README.md': project('Third', 'ENG') });
    assert.equal(await check(third, 'docs/page.md', inProject('ENG', 'Second')), true);
    assert.equal(await check(third, 'docs/page.md', inProject('ENG', 'First')), false, 'a cycle before the newest synchronized version');
    assert.equal(await check(third, 'docs/page.md', inProject('ENG', 'Third')), false);
  });

  it('reads a place that a merge or a team-only step gave the folder while a version lasted', async () => {
    const base = await commit([], { 'a/README.md': team('ONE'), 'a/x/README.md': project('P'), 'a/x/page.md': 'Page.\n' });
    const teamChanged = await commit([base], { 'a/README.md': team('TWO') });
    const projectChanged = await commit([base], { 'a/x/README.md': project('Q') });
    const merged = await commit([teamChanged, projectChanged], { 'a/x/README.md': project('Q') });
    const teamOnly = await commit([merged], { 'a/x/README.md': null });
    const last = await commit([teamOnly], { 'a/x/README.md': project('R') });
    for (const place of [inProject('ONE', 'P'), inProject('TWO', 'P'), inProject('TWO', 'Q'), inTeam('TWO'), inProject('TWO', 'R')]) assert.equal(await check(last, 'a/x/page.md', place), true, JSON.stringify(place));
    assert.equal(await check(last, 'a/x/page.md', inProject('ONE', 'Q')), false, 'only the merge result counts');
  });

  it('does not lend one file the places another file of the folder or another folder had', async () => {
    const first = await commit([], { 'docs/README.md': project('Notes', 'ENG'), 'docs/page.md': 'Page.\n', 'private/README.md': project('Payroll', 'ENG'), 'private/page.md': 'Page.\n' });
    const moved = await commit([first], { 'docs/README.md': project('Archive', 'ENG'), 'docs/new.md': 'New.\n' });
    assert.equal(await check(moved, 'docs/page.md', inProject('ENG', 'Payroll')), false);
    assert.equal(await check(moved, 'private/page.md', inProject('ENG', 'Payroll')), true);
    assert.equal(await check(moved, 'docs/new.md', inProject('ENG', 'Notes')), false, 'that file came after the move');
  });

  it('refuses, without failing, when a version it reaches has an unreadable annotation', async () => {
    const first = await commit([], { 'docs/README.md': project('First', 'ENG'), 'docs/page.md': 'Page.\n' });
    const large = await commit([first], { 'other/README.md': `---\nlinear-team: ENG\n---\n\n${'x'.repeat(MAPPING_FILE_BYTES)}\n`, 'docs/page.md': 'Page, edited.\n' });
    const tip = await commit([large], { 'other/README.md': null, 'docs/README.md': project('Second', 'ENG') });
    assert.equal(await check(tip, 'docs/page.md', inProject('ENG', 'First')), false);
    const edited = await commit([tip], { 'docs/page.md': 'Page, edited again.\n' });
    assert.equal(await check(edited, 'docs/page.md', inProject('ENG', 'Second')), true, 'the newest version is readable');
  });

  it('refuses, without failing, when a version it reaches lists a tree over the limit', async (t) => {
    const first = await commit([], { 'docs/README.md': project('First', 'ENG'), 'docs/page.md': 'Page.\n' });
    const large = await commit([first], { 'docs/page.md': 'Page, edited.\n' });
    const tip = await commit([large], { 'docs/README.md': project('Second', 'ENG') });
    // That commit's tree listing goes over its output limit, through the listing's own limit check.
    const listTree = git.listTree.bind(git);
    t.mock.method(git, 'listTree', (treeish: string, maxOutputBytes?: number) => listTree(treeish, treeish === large ? 1 : maxOutputBytes));
    assert.equal(await check(tip, 'docs/page.md', inProject('ENG', 'First')), false);
  });

  it('refuses a file the tracked branch never synchronized', async () => {
    const tip = await commit([], { 'docs/README.md': project('Notes', 'ENG'), 'docs/page.md': 'Page.\n' });
    assert.equal(await check(tip, 'docs/other.md', inProject('ENG', 'Notes')), false);
    assert.equal(await check(tip, 'private/page.md', inProject('ENG', 'Notes')), false);
  });

  it('ignores places that only commits a merge brought in had', async () => {
    const base = await commit([], { 'docs/README.md': project('Notes', 'ENG') });
    const named = await commit([base], { 'docs/README.md': project('Payroll', 'ENG'), 'docs/page.md': 'Page.\n' });
    const restored = await commit([named], { 'docs/README.md': project('Notes', 'ENG') });
    const merged = await commit([base, restored], { 'docs/page.md': 'Page.\n' });
    assert.equal(await check(merged, 'docs/page.md', inProject('ENG', 'Payroll')), false);
    assert.equal(await check(merged, 'docs/page.md', inProject('ENG', 'Notes')), true);
    assert.equal(await check(named, 'docs/page.md', inProject('ENG', 'Payroll')), true);
  });

  it('follows a folder moved under another team', async () => {
    const first = await commit([], { 'ops/README.md': team('OPS'), 'eng/README.md': team('ENG'), 'ops/pay/README.md': project('Pay'), 'ops/pay/page.md': 'Page.\n' });
    const moved = await commit([first], { 'ops/pay/README.md': null, 'ops/pay/page.md': null, 'eng/pay/README.md': project('Pay'), 'eng/pay/page.md': 'Page.\n' });
    assert.equal(await check(moved, 'eng/pay/page.md', inProject('ENG', 'Pay')), true);
    assert.equal(await check(moved, 'eng/pay/page.md', inProject('OPS', 'Pay')), false, 'that file never had the old team');
  });

  it('matches a name written in quotes', async () => {
    const tip = await commit([], { 'docs/README.md': '---\nlinear-team: ENG\nlinear-project: "Q1: \\"Plans\\""\n---\n', 'docs/page.md': 'Page.\n' });
    assert.equal(await check(tip, 'docs/page.md', inProject('ENG', 'Q1: "Plans"')), true);
  });

  it("allows the places the run lists without reading history, a pending move's only for its folder", async () => {
    const tip = await commit([], { 'docs/README.md': project('Notes', 'ENG') });
    const notes = { team: 'ENG', teamFolder: 'docs', project: 'Notes', projectFolder: 'docs' };
    const archive = { team: 'ENG', teamFolder: 'docs', project: 'Archive', projectFolder: 'docs' };
    // docs/ is on a pending move from Archive: the run lists Archive for its files only.
    const allowed = syncedPlaces(git, tip, new Map([['docs', notes]]), new Map([['docs', archive]]), LINEAR_FACTS);
    assert.equal(await allowed('other/page.md', inProject('ENG', 'Notes')), true);
    assert.equal(await allowed('other/page.md', inTeam('ENG')), false);
    assert.equal(await allowed('docs/sub/page.md', inProject('ENG', 'Archive')), true);
    assert.equal(await allowed('other/page.md', inProject('ENG', 'Archive')), false, 'a pending move lends its place to no other folder');
  });
  describe('a pending move', () => {
    it('allows only the place just before the latest change', async () => {
      const first = await commit([], { 'docs/README.md': project('First', 'ENG') });
      const second = await commit([first], { 'docs/README.md': project('Second', 'ENG') });
      const edited = await commit([second], { 'docs/README.md': project('Second', 'ENG') + 'More.\n' });
      const third = await commit([edited], { 'docs/README.md': project('Third', 'ENG') });
      assert.equal(await pendingMove(git, third, 'docs', inProject('ENG', 'Second'), inProject('ENG', 'Third')), true);
      assert.equal(await pendingMove(git, third, 'docs', inProject('ENG', 'First'), inProject('ENG', 'Third')), false, 'a place held before the previous one');
      assert.equal(await pendingMove(git, edited, 'docs', inProject('ENG', 'First'), inProject('ENG', 'Second')), true);
      assert.equal(await pendingMove(git, third, 'docs', inProject('ENG', 'Second'), inProject('ENG', 'First')), false, 'not the current place');
    });

    it('allows a second move once the folder went back to the recorded place', async () => {
      const first = await commit([], { 'docs/README.md': project('First', 'ENG') });
      const second = await commit([first], { 'docs/README.md': project('Second', 'ENG') });
      const back = await commit([second], { 'docs/README.md': project('First', 'ENG') });
      const third = await commit([back], { 'docs/README.md': project('Third', 'ENG') });
      assert.equal(await pendingMove(git, third, 'docs', inProject('ENG', 'First'), inProject('ENG', 'Third')), true);
    });

    it('takes the move from an inherited annotation', async () => {
      const first = await commit([], { 'README.md': team('OPS'), 'docs/README.md': '# Docs\n' });
      const moved = await commit([first], { 'README.md': team('ENG') });
      assert.equal(await pendingMove(git, moved, 'docs', inTeam('OPS'), inTeam('ENG')), true);
    });

    it('refuses a folder that never had another place', async () => {
      const tip = await commit([], { 'docs/README.md': project('Notes', 'ENG') });
      assert.equal(await pendingMove(git, tip, 'docs', inProject('ENG', 'Payroll'), inProject('ENG', 'Notes')), false);
      const unannotated = await commit([], { 'docs/README.md': '# Docs\n' });
      const annotated = await commit([unannotated], { 'docs/README.md': project('Notes', 'ENG') });
      assert.equal(await pendingMove(git, annotated, 'docs', inProject('ENG', 'Payroll'), inProject('ENG', 'Notes')), false);
    });

    it('ends once a merged sync record took the new place', async () => {
      const first = await commit([], { 'docs/README.md': project('Payroll', 'ENG') });
      const oldRecord = await record([first], {});
      const synced = await commit([first, oldRecord], {});
      const moved = await commit([synced], { 'docs/README.md': project('Notes', 'ENG') });
      const later = await commit([moved], { 'docs/page.md': 'Page.\n' });
      assert.equal(await pendingMove(git, later, 'docs', inProject('ENG', 'Payroll'), inProject('ENG', 'Notes')), true, 'a record from before the move');
      const newRecord = await record([oldRecord, moved], { 'docs/README.md': project('Notes', 'ENG') });
      const merged = await commit([later, newRecord], {});
      assert.equal(await pendingMove(git, merged, 'docs', inProject('ENG', 'Payroll'), inProject('ENG', 'Notes')), false);
    });

    it('ignores a record from an earlier stay in the new place that is merged after the move', async () => {
      const first = await commit([], { 'docs/README.md': project('Notes', 'ENG') });
      const earlier = await record([first], {});
      const away = await commit([first], { 'docs/README.md': project('Payroll', 'ENG') });
      const back = await commit([away], { 'docs/README.md': project('Notes', 'ENG') });
      const merged = await commit([back, earlier], {});
      assert.equal(await pendingMove(git, merged, 'docs', inProject('ENG', 'Payroll'), inProject('ENG', 'Notes')), true);
    });

    it('ignores a merged record that does not name the new place', async () => {
      const first = await commit([], { 'docs/README.md': project('Payroll', 'ENG'), 'other/README.md': project('Other', 'ENG') });
      const moved = await commit([first], { 'docs/README.md': project('Notes', 'ENG') });
      const otherRecord = await record([first], { 'other/page.md': 'Page.\n' });
      const merged = await commit([moved, otherRecord], { 'other/page.md': 'Page.\n' });
      assert.equal(await pendingMove(git, merged, 'docs', inProject('ENG', 'Payroll'), inProject('ENG', 'Notes')), true);
    });
  });

  describe('a move whose record the tracked branch lacks', () => {
    const unmerged = async (tracked: Oid, linear: Oid) => recordsUnmergedMove(git, tracked, linear, (await loadMapping(git, tracked)).zones);

    it('is found once the state ref took in the move, and ends when its record is merged', async () => {
      const first = await commit([], { 'docs/README.md': project('Payroll', 'ENG'), 'other/README.md': project('Other', 'ENG') });
      const moved = await commit([first], { 'docs/README.md': project('Notes', 'ENG') });
      const later = await commit([moved], { 'other/README.md': project('Other', 'ENG') + 'More.\n', 'docs/page.md': 'Page.\n' });
      const before = await record([first], {});
      assert.equal(await unmerged(later, before), false, 'the state ref has not taken in the move');
      const synced = await commitTree(git, { parents: [before, later], base: later, changes: new Map(), message: MERGE_RECORD_MESSAGE, identity: IDENTITY });
      assert.equal(await unmerged(later, synced), true);
      const merged = await commit([later, synced], {});
      assert.equal(await unmerged(merged, synced), false);
      assert.equal(await pendingMove(git, merged, 'docs', inProject('ENG', 'Payroll'), inProject('ENG', 'Notes')), false);
    });

    it('takes the move from an inherited annotation', async () => {
      const first = await commit([], { 'README.md': team('OPS'), 'docs/README.md': project('Notes'), 'docs/deep/README.md': '# Deep\n' });
      const moved = await commit([first], { 'README.md': team('ENG') });
      assert.equal(await unmerged(moved, await record([moved], {})), true);
    });

    it('finds none for folders that never had another place', async () => {
      const unannotated = await commit([], { 'docs/README.md': '# Docs\n', 'other/README.md': project('Other', 'ENG') });
      const annotated = await commit([unannotated], { 'docs/README.md': project('Notes', 'ENG') });
      const edited = await commit([annotated], { 'docs/README.md': project('Notes', 'ENG') + 'More.\n' });
      assert.equal(await unmerged(edited, await record([edited], {})), false);
    });

    it('reads a folder whose name holds the byte that marks a commit in the log', async () => {
      const first = await commit([], { 'a\x01b/README.md': project('Payroll', 'ENG') });
      const moved = await commit([first], { 'a\x01b/README.md': project('Notes', 'ENG') });
      assert.equal(await unmerged(moved, await record([moved], {})), true);
    });

    it('reads no README over the mapping limit, as a pending move does not', async () => {
      const first = await commit([], { 'docs/README.md': project('Payroll', 'ENG') + 'x'.repeat(MAPPING_FILE_BYTES) });
      const moved = await commit([first], { 'docs/README.md': project('Notes', 'ENG') });
      assert.equal(await pendingMove(git, moved, 'docs', inProject('ENG', 'Payroll'), inProject('ENG', 'Notes')), false);
      assert.equal(await unmerged(moved, await record([moved], {})), false);
    });

    it('reads many large README versions in more than one batch', async () => {
      let tip = await commit([], { 'docs/README.md': project('Payroll', 'ENG') });
      // 70 versions of almost 1 MB each: more than the mapping's 64 MiB blob budget in all.
      for (let version = 0; version < 70; version++) tip = await commit([tip], { 'docs/README.md': `${project('Notes', 'ENG')}${version} ${'x'.repeat(MAPPING_FILE_BYTES - 200)}` });
      assert.equal(await unmerged(tip, await record([tip], {})), true);
    });

    it('finds the same moves as a pending move, past merges and removed files', async () => {
      const base = await commit([], { 'a/README.md': team('ONE'), 'a/x/README.md': project('P'), 'b/README.md': project('B', 'ONE') });
      const side = await commit([base], { 'a/x/README.md': project('Q'), 'b/README.md': null });
      const merged = await commit([base, side], { 'a/x/README.md': project('Q'), 'b/README.md': null });
      assert.equal(await pendingMove(git, merged, 'a/x', inProject('ONE', 'P'), inProject('ONE', 'Q')), true);
      assert.equal(await unmerged(merged, await record([merged], {})), true);
    });
  });
});

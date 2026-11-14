import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type Fixture, createFixture, IDENTITY } from '../state/test-helpers.ts';
import { type Git, type Oid, commitTree } from '../state/index.ts';
import { type Place } from '../mapping/index.ts';
import { trackedPlaces } from './tracked-places.ts';

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
  const check = (tracked: Oid, folder: string, place: Place) => trackedPlaces(git, tracked, new Map())(folder, place);

  it('follows a folder moved under another team', async () => {
    const first = await commit([], { 'ops/README.md': team('OPS'), 'eng/README.md': team('ENG'), 'ops/pay/README.md': project('Pay') });
    const moved = await commit([first], { 'ops/pay/README.md': null, 'eng/pay/README.md': project('Pay') });
    assert.equal(await check(moved, 'eng/pay', inProject('ENG', 'Pay')), true);
    assert.equal(await check(moved, 'eng/pay', inProject('OPS', 'Pay')), false, 'that folder never had the old team');
  });

  it('reads a place that only a merge of two branches gave', async () => {
    const base = await commit([], { 'a/README.md': team('ONE'), 'a/x/README.md': project('P') });
    const teamChanged = await commit([base], { 'a/README.md': team('TWO') });
    const projectChanged = await commit([base], { 'a/x/README.md': project('Q') });
    const merged = await commit([teamChanged, projectChanged], { 'a/x/README.md': project('Q') });
    assert.equal(await check(merged, 'a/x', inProject('TWO', 'Q')), true);
  });

  it('ignores places that only commits a merge brought in had', async () => {
    const base = await commit([], { 'docs/README.md': project('Notes', 'ENG') });
    const named = await commit([base], { 'docs/README.md': project('Payroll', 'ENG') });
    const restored = await commit([named], { 'docs/README.md': project('Notes', 'ENG'), 'docs/page.md': 'Page.\n' });
    const merged = await commit([base, restored], { 'docs/page.md': 'Page.\n' });
    assert.equal(await check(merged, 'docs', inProject('ENG', 'Payroll')), false);
    assert.equal(await check(named, 'docs', inProject('ENG', 'Payroll')), true);
  });

  it('matches a name written in quotes', async () => {
    const tip = await commit([], { 'docs/README.md': '---\nlinear-team: ENG\nlinear-project: "Q1: \\"Plans\\""\n---\n' });
    assert.equal(await check(tip, 'docs', inProject('ENG', 'Q1: "Plans"')), true);
  });

  it('finds a team-only step between two projects of one team', async () => {
    const first = await commit([], { 'docs/README.md': project('First', 'ENG') });
    const teamOnly = await commit([first], { 'docs/README.md': team('ENG') });
    const second = await commit([teamOnly], { 'docs/README.md': project('Second', 'ENG') });
    assert.equal(await check(second, 'docs', inTeam('ENG')), true);
    assert.equal(await check(second, 'docs', inProject('ENG', 'First')), true);
  });

  it('does not lend one folder the place another folder had', async () => {
    const first = await commit([], { 'docs/README.md': project('Notes', 'ENG'), 'private/README.md': project('Payroll', 'ENG') });
    const removed = await commit([first], { 'private/README.md': null });
    assert.equal(await check(removed, 'docs', inProject('ENG', 'Payroll')), false);
    assert.equal(await check(removed, 'private', inProject('ENG', 'Payroll')), true);
    assert.equal(await check(removed, 'docs', inTeam('ENG')), false, 'the team alone was never the place of docs/');
  });

  it('allows the places of the current mapping without reading history', async () => {
    const tip = await commit([], { 'docs/README.md': project('Notes', 'ENG') });
    const allowed = trackedPlaces(git, tip, new Map([['docs', { team: 'ENG', teamFolder: 'docs', project: 'Notes', projectFolder: 'docs' }]]));
    assert.equal(await allowed('other', inProject('ENG', 'Notes')), true);
    assert.equal(await allowed('other', inTeam('ENG')), false);
  });
});

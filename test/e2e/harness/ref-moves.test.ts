// I4 keeps what differs when a ref moves to a commit that does not descend
// from its old one: the two commits may be gone from the remote by the time
// anyone reads the evidence (an initial sync from Linear replaces its record,
// and the harness deletes the run's refs in cleanup).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, it } from 'node:test';
import { Git, commitTree } from '../../../src/state/index.ts';
import { IDENTITY, createFixture, type Fixture } from '../../../src/state/test-helpers.ts';
import type { RunContext } from './context.ts';
import { INVARIANT_CHECKS, REF_MOVES, snapshotRefs, type RefMove } from './checks.ts';
import { runNames } from './isolation.ts';
import { writeRunRefs } from './runner.ts';

const POINTER = (oid: string, size: number) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

let fixture: Fixture;
beforeEach(async () => { fixture = await createFixture(); });
afterEach(async () => { await fixture.cleanup(); });

it('I4 names the ref that moved to a sibling and keeps the paths and the patch between the two commits', async () => {
  const names = runNames('abc123');
  await fixture.seed({ 'eng/notes/plan.md': '# Plan\n\n![Diagram](../images/diagram.png)\n', 'eng/images/diagram.png': POINTER('1'.repeat(64), 10), 'eng/images/photo.jpg': 'jpeg bytes' }, { branch: names.trackedBranch });
  const tracked = (await fixture.remote.text(['rev-parse', `refs/heads/${names.trackedBranch}`])).trim();
  const record = (changes: Record<string, string | null>) => commitTree(fixture.remote, { parents: [tracked], base: tracked, changes: new Map(Object.entries(changes)), message: 'Record', identity: IDENTITY, skipIfUnchanged: false });
  // Two records on the same parent: the first one's text, then a sibling with another image link, pointer and file.
  const first = await record({ 'eng/notes/plan.md': '# Plan\n\nFirst.\n\n![Diagram](../images/diagram.png)\n' });
  const second = await record({ 'eng/notes/plan.md': '# Plan\n\nFirst.\n\n![Diagram](abc.png)\n', 'eng/images/diagram.png': POINTER('2'.repeat(64), 11), 'eng/notes/abc.png': 'new bytes\0' });
  // A forward move of another ref is not a finding.
  const linear = `${names.refPrefix}/linear`;
  const ids = `${names.refPrefix}/ids`;
  const history = [{ [linear]: first, [ids]: tracked }, { [linear]: second, [ids]: first }];
  for (const [ref, oid] of [[linear, second], [ids, first]] as const) await fixture.remote.run(['update-ref', ref, oid]);
  const person = await fixture.clone('person');
  const observations = new Map<string, unknown>([['refHistory', history]]);
  const ctx = { names, observations, person: async () => person } as unknown as RunContext;

  assert.deepEqual(await INVARIANT_CHECKS.I4(ctx, async () => { throw new Error('I4 reads no world'); }), { name: 'I4', ok: false, detail: 'refs moved other than forward: linear' });
  const [move, ...rest] = observations.get(REF_MOVES) as RefMove[];
  assert.deepEqual(rest, []);
  assert.deepEqual({ ...move, patch: undefined }, { ref: 'linear', snapshot: 1, old: first, next: second, paths: ['M\teng/images/diagram.png', 'A\teng/notes/abc.png', 'M\teng/notes/plan.md'], patch: undefined });
  // The Markdown and the LFS pointer as text; other binary files by name.
  assert.match(move!.patch, /^-!\[Diagram\]\(\.\.\/images\/diagram\.png\)$/m);
  assert.match(move!.patch, /^\+!\[Diagram\]\(abc\.png\)$/m);
  assert.match(move!.patch, /^\+oid sha256:2{64}$/m);
  assert.match(move!.patch, /^Binary files \/dev\/null and b\/eng\/notes\/abc\.png differ$/m);

  // The run's evidence writes them next to the raw ref maps.
  const dir = mkdtempSync(join(tmpdir(), 'ref-moves-'));
  try {
    writeRunRefs(ctx, dir);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'ref-moves.json'), 'utf8')), [move]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('ref snapshots keep each commit they see, so I4 compares a replaced record the remote has since dropped', async () => {
  const names = runNames('abc125');
  await fixture.seed({ 'eng/notes/plan.md': '# Plan\n' }, { branch: names.trackedBranch });
  const tracked = (await fixture.remote.text(['rev-parse', `refs/heads/${names.trackedBranch}`])).trim();
  const record = (text: string) => commitTree(fixture.remote, { parents: [tracked], base: tracked, changes: new Map([['eng/notes/plan.md', text]]), message: 'Record', identity: IDENTITY, skipIfUnchanged: false });
  const linear = `${names.refPrefix}/linear`;
  const sync = `refs/heads/${names.syncBranch}`;
  // The harness's sandbox cache, where the snapshots keep the commits they see. The person's clone stands alone,
  // as `Sandbox.clone` makes it: I4 reads the kept commits through the cache, never by fetching from it.
  const cache = new Git(join(fixture.root, 'cache.git'));
  await new Git(fixture.root).run(['init', '--quiet', '--bare', cache.dir]);
  await cache.run(['fetch', '--quiet', fixture.url, `refs/heads/${names.trackedBranch}`]);
  await new Git(fixture.root).run(['clone', '--quiet', fixture.url, join(fixture.root, 'person')]);
  const person = new Git(join(fixture.root, 'person'));
  // The sandbox lists the run's refs as the live harness reads them.
  const runRefs = async () => (await fixture.remote.text(['for-each-ref', '--format=%(refname) %(objectname)', names.refPrefix, sync])).split('\n').filter(Boolean).map((line) => {
    const [ref, oid] = line.split(' ') as [string, string];
    return { ref, oid, runId: names.runId };
  });
  const observations = new Map<string, unknown>();
  const ctx = { names, observations, person: async () => person, live: { sandbox: { runRefs, cache, url: fixture.url } } } as unknown as RunContext;

  // The sync branch and `linear` hold the same record, as after an initial sync from Linear.
  const first = await record('# Plan\n\nFirst.\n');
  for (const ref of [linear, sync]) await fixture.remote.run(['update-ref', ref, first]);
  const history = [await snapshotRefs(ctx)];
  // The replacement moves the ref to a sibling; nothing on the remote holds the first record any more, and it is pruned.
  const second = await record('# Plan\n\nSecond.\n');
  for (const ref of [linear, sync]) await fixture.remote.run(['update-ref', ref, second]);
  await fixture.remote.run(['reflog', 'expire', '--expire=now', '--all']);
  await fixture.remote.run(['gc', '--quiet', '--prune=now']);
  assert.notEqual((await fixture.remote.run(['cat-file', '-e', first], { okCodes: [0, 1, 128] })).code, 0);
  history.push(await snapshotRefs(ctx));
  observations.set('refHistory', history);

  assert.deepEqual(history, [{ [linear]: first, [sync]: first }, { [linear]: second, [sync]: second }]);
  assert.equal((await INVARIANT_CHECKS.I4(ctx, async () => ({}) as never)).ok, false);
  const moves = observations.get(REF_MOVES) as RefMove[];
  assert.deepEqual(moves.map((move) => move.ref).sort(), ['linear', 'sync branch']);
  for (const move of moves) {
    assert.deepEqual(move.paths, ['M\teng/notes/plan.md']);
    assert.match(move.patch, /^-First\.\n\+Second\.$/m);
  }
});

it('I4 records a move whose old commit the remote no longer has, without a diff', async () => {
  const names = runNames('abc124');
  await fixture.seed({ 'a.md': '# A\n' }, { branch: names.trackedBranch });
  const tracked = (await fixture.remote.text(['rev-parse', `refs/heads/${names.trackedBranch}`])).trim();
  const linear = `${names.refPrefix}/linear`;
  const gone = 'f'.repeat(40);
  const person = await fixture.clone('person');
  const observations = new Map<string, unknown>([['refHistory', [{ [linear]: gone }, { [linear]: tracked }]]]);
  const ctx = { names, observations, person: async () => person } as unknown as RunContext;
  assert.equal((await INVARIANT_CHECKS.I4(ctx, async () => ({}) as never)).ok, false);
  assert.deepEqual(observations.get(REF_MOVES), [{ ref: 'linear', snapshot: 1, old: gone, next: tracked, paths: [], patch: '', error: 'the two commits could not be compared' }]);
});

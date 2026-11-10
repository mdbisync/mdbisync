// Checks a run's reported writes against what the fake Linear, the fake
// GitHub and the bare remote saw, for tests that run the command line.

import assert from 'node:assert/strict';
import { type FakeWorld } from '../setup/test-helpers.ts';
import { type Fixture, remoteRef } from '../state/test-helpers.ts';
import { type RunWrites } from './operation.ts';

/** The refs a run may push with the default configuration, by the role the report names them with. */
const REFS = {
  linear: 'refs/mdbisync/linear',
  ids: 'refs/mdbisync/ids',
  uploads: 'refs/mdbisync/uploads',
  syncBranch: 'refs/heads/mdbisync/linear',
  suspendedBranch: 'refs/heads/mdbisync/suspended',
} as const;

/** The Linear mutations that write a document or a comment; uploads are compared by the bytes storage took. */
const DOCUMENT_WRITES = new Set(['CreateDocument', 'UpdateDocument', 'TrashDocument', 'RestoreDocument', 'CommentOnDocument', 'UpdateDocumentComment', 'ResolveComment']);
const PULL_REQUEST_WRITE = /^(POST \/pulls|PATCH \/pulls\/\d+|PUT \/pulls\/\d+\/merge)$/;

export interface WorldMark {
  writes: number;
  stored: number;
  refs: Record<keyof typeof REFS, string | null>;
}

/** What the world holds before a run, to compare with after it. */
export async function markWorld(world: FakeWorld, fixture: Fixture): Promise<WorldMark> {
  const refs = {} as WorldMark['refs'];
  for (const [role, ref] of Object.entries(REFS)) refs[role as keyof typeof REFS] = await remoteRef(fixture, ref);
  return { writes: world.writes.length, stored: stored(world), refs };
}

/**
 * Asserts that the report's `writes` match what reached the world since
 * `mark`. Refs: a role whose ref moved is counted, one whose ref stayed is
 * not (a ref only moves forward, so a moved ref ends away from its start);
 * a ref the test moves itself during the run is left out.
 * Linear and GitHub: the counts equal the writes the fakes took, unless the
 * test made a fake refuse writes or lose answers, when a write the fake saw
 * may not have succeeded for the run.
 */
export async function assertWritesMatchWorld(
  world: FakeWorld,
  fixture: Fixture,
  mark: WorldMark,
  writes: RunWrites,
  options: { faults: boolean; movedByOthers?: ReadonlyArray<keyof typeof REFS> },
): Promise<void> {
  for (const [role, ref] of Object.entries(REFS)) {
    if (options.movedByOthers?.includes(role as keyof typeof REFS) === true) continue;
    const moved = (await remoteRef(fixture, ref)) !== mark.refs[role as keyof typeof REFS];
    assert.equal((writes.git[role as keyof typeof REFS] ?? 0) > 0, moved, `reported ${role} moves (${writes.git[role as keyof typeof REFS] ?? 0}) against the remote (${moved ? 'moved' : 'unchanged'})`);
  }
  if (options.faults || world.linear.writes.reject !== undefined || world.linear.writes.rateLimitAt !== undefined || world.github.reset !== undefined) return;
  const seen = world.writes.slice(mark.writes);
  const linear = { ...writes.linear };
  delete linear['FileUpload'];
  assert.deepEqual(linear, countBy(seen.filter((write) => DOCUMENT_WRITES.has(write))), 'reported Linear writes against the fake');
  assert.equal(writes.linear['FileUpload'] ?? 0, stored(world) - mark.stored, 'reported uploads against the files storage took');
  const pullRequests = Object.values(writes.pullRequests).reduce((sum, count) => sum + count, 0);
  assert.equal(pullRequests, seen.filter((write) => PULL_REQUEST_WRITE.test(write)).length, 'reported pull request writes against the fake');
}

function stored(world: FakeWorld): number {
  return world.linear.uploads.filter((upload) => upload.bytes !== undefined).length;
}

function countBy(names: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of [...names].sort()) counts[name] = (counts[name] ?? 0) + 1;
  return counts;
}

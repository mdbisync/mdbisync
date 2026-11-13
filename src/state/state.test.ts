import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import {
  Git,
  GitError,
  type IdMap,
  NotFastForwardError,
  commitIds,
  commitTree,
  commitUploads,
  fetchState,
  landedRefs,
  listTree,
  pushAtomic,
  readBlobs,
  readFiles,
  readIds,
  readUploads,
  refusedPushes,
  resolveStateConfig,
  stateRef,
} from './index.ts';
import { type Fixture, IDENTITY, countLocalLfsObjects, createFixture, remoteRef } from './test-helpers.ts';

const config = resolveStateConfig();
const LINEAR = stateRef(config, 'linear');
const IDS = stateRef(config, 'ids');
const UPLOADS = stateRef(config, 'uploads');
const SYNC = 'refs/heads/mdbisync/linear';

/** Builds the three state commits a run would push, distinct per writer. */
async function buildState(git: Git, tracked: string, writer: string) {
  const linear = await commitTree(git, {
    parents: [tracked],
    base: tracked,
    changes: new Map([['docs/a.md', `# A\n\nWritten by ${writer}.\n`]]),
    message: 'Record Linear',
    identity: IDENTITY,
  });
  const ids = await commitIds(git, null, new Map([['docs/a.md', { id: `doc-${writer}` }]]), IDENTITY);
  const uploads = await commitUploads(git, null, new Map([['f'.repeat(64), `https://uploads.example.com/${writer}`]]), IDENTITY);
  return { linear, ids, uploads };
}

describe('state: stores and atomic lease pushes', () => {
  let fixture: Fixture;
  before(async () => {
    fixture = await createFixture();
    await fixture.seed({ 'docs/a.md': '# A\n', 'docs/b.md': '# B\n', 'tool.sh': '#!/bin/sh\n' }, { executable: ['tool.sh'] });
  });
  after(async () => fixture.cleanup());

  it('reads a repository without state', async () => {
    const git = await fixture.clone('empty-state');
    const fetched = await fetchState(git, config);
    assert.match(fetched.tracked, /^[0-9a-f]{40}$/);
    assert.equal(fetched.sync, null);
    assert.deepEqual(fetched.state, { linear: null, ids: null, uploads: null });
    assert.deepEqual(await readIds(git, null), new Map());
    assert.deepEqual(await readUploads(git, null), new Map());
  });

  it('refuses a tracked branch that does not exist', async () => {
    const git = await fixture.clone('no-branch');
    await assert.rejects(fetchState(git, resolveStateConfig({ trackedBranch: 'nothing-here' })), /does not exist/);
  });

  it('creates the three refs in one push and reads them back elsewhere', async () => {
    const writer = await fixture.clone('creator');
    const { tracked, state } = await fetchState(writer, config);
    const ids: IdMap = new Map([
      ['docs/b.md', { id: 'doc-b', saved: { icon: 'Book', color: null } }],
      ['docs/a.md', { id: 'doc-a' }],
    ]);
    const next = {
      linear: await commitTree(writer, { parents: [tracked], base: tracked, changes: new Map(), message: 'Record Linear', identity: IDENTITY, skipIfUnchanged: false }),
      ids: await commitIds(writer, state.ids, ids, IDENTITY),
      uploads: await commitUploads(writer, state.uploads, new Map([['0'.repeat(64), 'https://uploads.example.com/x']]), IDENTITY),
    };
    const result = await pushAtomic(writer, config, [
      { ref: LINEAR, expected: null, next: next.linear },
      { ref: IDS, expected: null, next: next.ids },
      { ref: UPLOADS, expected: null, next: next.uploads },
    ]);
    assert.deepEqual(result, { ok: true, updated: [LINEAR, IDS, UPLOADS] });
    assert.equal(await remoteRef(fixture, LINEAR), next.linear);

    const reader = await fixture.clone('reader');
    const fetched = await fetchState(reader, config);
    assert.deepEqual(fetched.state, next);
    assert.deepEqual(await readIds(reader, fetched.state.ids), ids);
    assert.deepEqual(await readUploads(reader, fetched.state.uploads), new Map([['0'.repeat(64), 'https://uploads.example.com/x']]));
    // The id file is stable: sorted by path, one entry per path.
    const [entry] = await listTree(reader, fetched.state.ids as string);
    const text = (await readBlobs(reader, [entry?.oid as string])).get(entry?.oid as string)?.toString('utf8');
    assert.ok(text !== undefined && text.indexOf('docs/a.md') < text.indexOf('docs/b.md'));

    // Nothing changed: no new commits and nothing to push (idempotent run).
    assert.equal(await commitIds(reader, fetched.state.ids, ids, IDENTITY), fetched.state.ids);
    assert.deepEqual(await pushAtomic(reader, config, [{ ref: IDS, expected: fetched.state.ids, next: fetched.state.ids as string }]), { ok: true, updated: [] });
  });

  it('lets exactly one of two writers with the same expected values win, and the other changes nothing', async () => {
    const first = await fixture.clone('writer-1');
    const second = await fixture.clone('writer-2');
    const a = await fetchState(first, config);
    const b = await fetchState(second, config);
    assert.deepEqual(a.state, b.state);

    const nextA = await buildState(first, a.tracked, 'first');
    const nextB = await buildState(second, b.tracked, 'second');
    const updates = (state: typeof a.state, next: typeof nextA) => [
      { ref: LINEAR, expected: state.linear, next: next.linear, replace: true },
      { ref: IDS, expected: state.ids, next: next.ids, replace: true },
      { ref: UPLOADS, expected: state.uploads, next: next.uploads, replace: true },
    ];
    const [resultA, resultB] = await Promise.all([pushAtomic(first, config, updates(a.state, nextA)), pushAtomic(second, config, updates(b.state, nextB))]);

    const results = [resultA, resultB];
    assert.equal(results.filter((result) => result.ok).length, 1, 'exactly one push succeeds');
    const winner = resultA.ok ? { next: nextA, git: first } : { next: nextB, git: second };
    const loser = resultA.ok ? { result: resultB, git: second, before: b.state } : { result: resultA, git: first, before: a.state };
    assert.equal(loser.result.ok, false);
    assert.ok(!loser.result.ok && loser.result.reason === 'stale', JSON.stringify(loser.result));

    // Every remote ref holds the winner's value: nothing of the loser's got in.
    assert.equal(await remoteRef(fixture, LINEAR), winner.next.linear);
    assert.equal(await remoteRef(fixture, IDS), winner.next.ids);
    assert.equal(await remoteRef(fixture, UPLOADS), winner.next.uploads);
    // The loser's own copies of the state still hold what it fetched.
    for (const [ref, value] of [[LINEAR, loser.before.linear], [IDS, loser.before.ids], [UPLOADS, loser.before.uploads]] as const) {
      const local = await loser.git.run(['rev-parse', '--verify', '--quiet', ref], { okCodes: [0, 1] });
      assert.equal(local.code === 0 ? local.stdout.toString('utf8').trim() : null, value);
    }
  });

  it('refuses all refs when only one lease is stale', async () => {
    const writer = await fixture.clone('partial-writer');
    const other = await fixture.clone('partial-other');
    const seen = await fetchState(writer, config);
    const otherSeen = await fetchState(other, config);

    // Someone else moves only `ids`.
    const otherIds = await commitIds(other, otherSeen.state.ids, new Map([['docs/z.md', { id: 'doc-z' }]]), IDENTITY);
    assert.ok((await pushAtomic(other, config, [{ ref: IDS, expected: otherSeen.state.ids, next: otherIds }])).ok);

    const next = await buildState(writer, seen.tracked, 'late');
    const result = await pushAtomic(writer, config, [
      { ref: LINEAR, expected: seen.state.linear, next: next.linear, replace: true },
      { ref: IDS, expected: seen.state.ids, next: next.ids, replace: true },
      { ref: UPLOADS, expected: seen.state.uploads, next: next.uploads, replace: true },
    ]);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason === 'stale' && result.refs.some((ref) => ref.ref === IDS));
    assert.equal(await remoteRef(fixture, LINEAR), seen.state.linear);
    assert.equal(await remoteRef(fixture, UPLOADS), seen.state.uploads);
    assert.equal(await remoteRef(fixture, IDS), otherIds);
    // The refusal is logged for the run's report, with nothing moved.
    assert.deepEqual(refusedPushes(writer), [{ refs: [LINEAR, IDS, UPLOADS], moved: [], output: [], pushed: {}, remoteAfter: {} }]);
    assert.deepEqual(refusedPushes(other), []);
  });

  /**
   * A refused atomic push whose output git reports `linear` updated. Another
   * run's push lands between this push's ref advertisement and the remote's
   * transaction: the hook moves `ids` there, and `linear` to the winning
   * run's value or this push's own (`linear`), so the remote refuses the atomic push. git itself reports
   * every ref of such a push rejected; this remote answers `ok` for `linear`,
   * which git prints as an updated ref, as GitHub did in live runs.
   */
  async function refuseReportingLinear(name: string, linear: 'kept' | 'winner' | 'pushed') {
    const writer = await fixture.clone(`${name}-writer`);
    const other = await fixture.clone(`${name}-other`);
    const seen = await fetchState(writer, config);
    const otherSeen = await fetchState(other, config);
    const otherIds = await commitIds(other, otherSeen.state.ids, new Map([[`docs/${name}.md`, { id: `doc-${name}` }]]), IDENTITY);
    const winner = linear === 'winner' ? (await buildState(other, otherSeen.tracked, `${name}-winner`)).linear : null;
    await other.run(['push', '--quiet', fixture.url, `${otherIds}:refs/heads/${name}-ids`, ...(winner === null ? [] : [`${winner}:refs/heads/${name}-linear`])]);
    const next = await buildState(writer, seen.tracked, name);
    const linearAfter = linear === 'winner' ? winner : linear === 'pushed' ? next.linear : null;

    const hook = join(fixture.remote.dir, 'hooks', 'pre-receive');
    const moves = [`git update-ref ${IDS} ${otherIds}`, ...(linearAfter === null ? [] : [`git update-ref ${LINEAR} ${linearAfter}`])];
    await writeFile(hook, `#!/bin/sh\ncat >/dev/null\nunset GIT_QUARANTINE_PATH\n${moves.join('\n')}\n`, { mode: 0o755 });
    const short = (oid: string | null) => (oid as string).slice(0, 7);
    const reported = ` \t${next.linear}:${LINEAR}\t${short(seen.state.linear)}..${short(next.linear)}`;
    try {
      const reporting = new (class extends Git {
        override async run(args: readonly string[], options?: Parameters<Git['run']>[1]) {
          const result = await super.run(args, options);
          if (args[0] !== 'push') return result;
          const stdout = result.stdout.toString('utf8');
          // git's own line for the refused ref, as git prints it: the rewrite below needs it.
          const refused = stdout.split('\n').find((line) => line.startsWith(`!\t${next.linear}:${LINEAR}\t`));
          assert.ok(refused !== undefined, stdout);
          return { ...result, stdout: Buffer.from(stdout.replace(refused, reported)) };
        }
      })(writer.dir);
      const result = await pushAtomic(reporting, config, [
        { ref: LINEAR, expected: seen.state.linear, next: next.linear, replace: true },
        { ref: IDS, expected: seen.state.ids, next: next.ids, replace: true },
        { ref: UPLOADS, expected: seen.state.uploads, next: next.uploads, replace: true },
      ]);
      assert.ok(!result.ok && result.reason === 'stale', JSON.stringify(result));
      assert.equal(await remoteRef(fixture, IDS), otherIds);
      const [refusal] = refusedPushes(reporting);
      assert.ok(refusal !== undefined);
      return { refusal, seen, next, winner, otherIds, reported };
    } finally {
      await rm(hook, { force: true });
    }
  }

  it('keeps the output and the remote refs of a refused push that reports a ref updated', async () => {
    const { refusal, seen, next, reported } = await refuseReportingLinear('reported', 'kept');
    assert.deepEqual(refusal.refs, [LINEAR, IDS, UPLOADS]);
    assert.deepEqual(refusal.moved, [LINEAR]);
    assert.deepEqual(refusal.pushed, { [LINEAR]: next.linear });
    // The remote never took the reported value: `linear` holds what this run expected.
    assert.deepEqual(refusal.remoteAfter, { [LINEAR]: seen.state.linear });
    assert.equal(await remoteRef(fixture, LINEAR), seen.state.linear);
    assert.deepEqual(landedRefs(refusal), []);
    // git's output as it came: the porcelain lines, then its errors.
    assert.ok(refusal.output.includes(reported), refusal.output.join('\n'));
    assert.ok(refusal.output.includes(`!\t${next.ids}:${IDS}\t[remote rejected] (atomic transaction failed)`), refusal.output.join('\n'));
    assert.ok(refusal.output.some((line) => line.startsWith('error: failed to push some refs')), refusal.output.join('\n'));
  });

  it('does not count a ref git reports updated while the remote holds the winning run\'s value', async () => {
    // As in a live run: the winning run moved both `ids` and `linear`; git
    // still printed this push's `linear` as updated.
    const { refusal, next, winner, reported } = await refuseReportingLinear('misreported', 'winner');
    assert.deepEqual(refusal.moved, [LINEAR]);
    assert.deepEqual(refusal.pushed, { [LINEAR]: next.linear });
    assert.deepEqual(refusal.remoteAfter, { [LINEAR]: winner });
    assert.equal(await remoteRef(fixture, LINEAR), winner);
    assert.deepEqual(landedRefs(refusal), []);
    assert.ok(refusal.output.includes(reported), refusal.output.join('\n'));
  });

  it('counts a ref of a refused push that the remote holds at the pushed value', async () => {
    const { refusal, next } = await refuseReportingLinear('landed', 'pushed');
    assert.deepEqual(refusal.remoteAfter, { [LINEAR]: next.linear });
    assert.deepEqual(landedRefs(refusal), [LINEAR]);
  });

  it('keeps the lease of a ref the run did not change', async () => {
    const writer = await fixture.clone('unchanged-writer');
    const other = await fixture.clone('unchanged-other');
    const seen = await fetchState(writer, config);
    const otherSeen = await fetchState(other, config);

    const otherIds = await commitIds(other, otherSeen.state.ids, new Map([['docs/y.md', { id: 'doc-y' }]]), IDENTITY);
    assert.ok((await pushAtomic(other, config, [{ ref: IDS, expected: otherSeen.state.ids, next: otherIds }])).ok);

    // The writer built its uploads from the ids it saw, which are now stale.
    const uploads = await commitUploads(writer, seen.state.uploads, new Map([['c'.repeat(64), 'https://uploads.example.com/c']]), IDENTITY);
    const result = await pushAtomic(writer, config, [
      { ref: IDS, expected: seen.state.ids, next: seen.state.ids as string },
      { ref: UPLOADS, expected: seen.state.uploads, next: uploads, replace: true },
    ]);
    assert.ok(!result.ok && result.reason === 'stale', JSON.stringify(result));
    assert.equal(await remoteRef(fixture, UPLOADS), seen.state.uploads);
    assert.equal(await remoteRef(fixture, IDS), otherIds);
  });

  it('refuses the push when a ref already holds the new value but not the expected one', async () => {
    const fresh = resolveStateConfig({ refPrefix: 'refs/already' });
    const writer = await fixture.clone('already-there');
    const { tracked } = await fetchState(writer, fresh);
    const next = await buildState(writer, tracked, 'already');
    // Someone else already pushed this very ids commit.
    assert.ok((await pushAtomic(writer, fresh, [{ ref: stateRef(fresh, 'ids'), expected: null, next: next.ids }])).ok);

    const result = await pushAtomic(writer, fresh, [
      { ref: stateRef(fresh, 'ids'), expected: null, next: next.ids },
      { ref: stateRef(fresh, 'uploads'), expected: null, next: next.uploads },
    ]);
    assert.ok(!result.ok && result.reason === 'stale', JSON.stringify(result));
    assert.equal(await remoteRef(fixture, stateRef(fresh, 'uploads')), null);
  });

  it('refuses a state commit that lacks its file instead of reading it as empty', async () => {
    const git = await fixture.clone('damaged');
    const damaged = await commitTree(git, { parents: [], base: null, changes: new Map([['other.json', '{}\n']]), message: 'x', identity: IDENTITY });
    await assert.rejects(readIds(git, damaged), /ids\.json is missing/);
    await assert.rejects(readUploads(git, damaged), /uploads\.json is missing/);
  });

  it('builds commits with removed paths in a bare repository', async () => {
    const tracked = await fixture.remote.text(['rev-parse', 'refs/heads/main']);
    const commit = await commitTree(fixture.remote, {
      parents: [tracked],
      base: tracked,
      changes: new Map<string, string | null>([['docs/b.md', null], ['docs/a.md', '# A\n\nChanged.\n']]),
      message: 'Remove a file',
      identity: IDENTITY,
    });
    const paths = (await listTree(fixture.remote, commit)).map((entry) => entry.path).sort();
    assert.ok(paths.includes('docs/a.md') && !paths.includes('docs/b.md'), paths.join(','));
  });

  it('refuses to create a ref that already exists', async () => {
    const writer = await fixture.clone('creator-late');
    const { tracked } = await fetchState(writer, config);
    const next = await buildState(writer, tracked, 'creator-late');
    const before = await remoteRef(fixture, LINEAR);
    const result = await pushAtomic(writer, config, [{ ref: LINEAR, expected: null, next: next.linear }]);
    assert.equal(result.ok, false);
    assert.equal(await remoteRef(fixture, LINEAR), before);
  });

  it('only moves a ref forward unless the update says it replaces it', async () => {
    const writer = await fixture.clone('forward');
    const { state } = await fetchState(writer, config);
    const unrelated = await commitIds(writer, null, new Map([['docs/other.md', { id: 'doc-other' }]]), IDENTITY);
    await assert.rejects(pushAtomic(writer, config, [{ ref: IDS, expected: state.ids, next: unrelated }]), NotFastForwardError);
    assert.equal(await remoteRef(fixture, IDS), state.ids);

    const child = await commitIds(writer, state.ids, new Map([['docs/child.md', { id: 'doc-child' }]]), IDENTITY);
    assert.deepEqual(await pushAtomic(writer, config, [{ ref: IDS, expected: state.ids, next: child }]), { ok: true, updated: [IDS] });

    assert.deepEqual(await pushAtomic(writer, config, [{ ref: IDS, expected: child, next: unrelated, replace: true }]), { ok: true, updated: [IDS] });
    assert.equal(await remoteRef(fixture, IDS), unrelated);
  });

  it('reports a push the remote declines for another reason as rejected, not stale', async () => {
    const blocked = resolveStateConfig({ refPrefix: 'refs/blocked' });
    const hook = join(fixture.remote.dir, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\nif grep -q refs/blocked/; then echo "declined by policy" >&2; exit 1; fi\nexit 0\n', { mode: 0o755 });
    try {
      const writer = await fixture.clone('declined');
      const { tracked } = await fetchState(writer, blocked);
      const next = await buildState(writer, tracked, 'declined');
      const result = await pushAtomic(writer, blocked, [
        { ref: stateRef(blocked, 'linear'), expected: null, next: next.linear },
        { ref: stateRef(blocked, 'ids'), expected: null, next: next.ids },
      ]);
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.reason === 'rejected', JSON.stringify(result));
      // Not a lost lease: no other run moved anything.
      assert.deepEqual(refusedPushes(writer), []);
      assert.equal(await remoteRef(fixture, stateRef(blocked, 'linear')), null);
      assert.equal(await remoteRef(fixture, stateRef(blocked, 'ids')), null);
    } finally {
      await rm(hook, { force: true });
    }
  });

  it('throws when the remote cannot be reached', async () => {
    const writer = await fixture.clone('unreachable');
    const { tracked } = await fetchState(writer, config);
    const next = await buildState(writer, tracked, 'unreachable');
    const gone = resolveStateConfig({ remote: 'gone' });
    await writer.run(['remote', 'add', 'gone', `${fixture.url}-missing`]);
    await assert.rejects(pushAtomic(writer, gone, [{ ref: LINEAR, expected: null, next: next.linear }]), GitError);
  });

  it('pushes the sync branch together with the state refs and tracks it locally', async () => {
    const writer = await fixture.clone('sync-branch');
    const { tracked, state, sync } = await fetchState(writer, config);
    assert.equal(sync, null);
    const linear = await commitTree(writer, {
      parents: [state.linear as string],
      base: state.linear,
      changes: new Map([['docs/b.md', '# B\n\nFrom Linear.\n']]),
      message: 'Capture',
      identity: IDENTITY,
    });
    const result = await pushAtomic(writer, config, [
      { ref: LINEAR, expected: state.linear, next: linear },
      { ref: SYNC, expected: null, next: linear },
    ]);
    assert.ok(result.ok);
    assert.equal(await remoteRef(fixture, SYNC), linear);
    assert.equal(await writer.text(['rev-parse', 'refs/remotes/origin/mdbisync/linear']), linear);
    const again = await fetchState(writer, config);
    assert.equal(again.sync, linear);
    assert.equal(again.tracked, tracked);
  });

  it('builds the linear commit from the tracked tree with synced files replaced', async () => {
    const git = await fixture.clone('linear-tree');
    const { tracked } = await fetchState(git, config);
    const commit = await commitTree(git, {
      parents: [tracked],
      base: tracked,
      changes: new Map<string, string | null>([
        ['docs/a.md', '# A\n\nAs Linear returned it.\n'],
        ['docs/new/c.md', '# C\n'],
        ['docs/b.md', null],
      ]),
      message: 'Record Linear',
      identity: IDENTITY,
    });
    assert.equal(await git.text(['rev-parse', `${commit}^1`]), tracked);
    const entries = new Map((await listTree(git, commit)).map((entry) => [entry.path, entry]));
    assert.deepEqual([...entries.keys()].sort(), ['docs/a.md', 'docs/new/c.md', 'tool.sh']);
    assert.equal(entries.get('tool.sh')?.mode, '100755', 'other files keep their mode');
    const blobs = await readBlobs(git, [entries.get('docs/a.md')?.oid as string]);
    assert.equal([...blobs.values()][0]?.toString('utf8'), '# A\n\nAs Linear returned it.\n');
    // The repository's own index is not touched.
    assert.equal((await git.run(['ls-files'])).stdout.length, 0);
    await assert.rejects(
      commitTree(git, { parents: [tracked], base: tracked, changes: new Map([['../escape.md', 'x']]), message: 'x', identity: IDENTITY }),
      /invalid repository path/,
    );
  });
});

describe('state: reading the tracked tree and LFS', () => {
  let fixture: Fixture;
  const images = Array.from({ length: 6 }, (_, index) => randomBytes(2000 + index));
  const plainImage = randomBytes(300);

  before(async () => {
    fixture = await createFixture();
    const files: Record<string, Buffer | string> = { 'docs/guide.md': '# Guide\n', 'plain/icon.gif': plainImage };
    images.forEach((image, index) => (files[`docs/img/picture-${index}.png`] = image));
    // A pointer whose object was never uploaded.
    const missing = randomBytes(64).toString('hex').slice(0, 64);
    files['docs/img/missing.png'] = `version https://git-lfs.github.com/spec/v1\noid sha256:${missing}\nsize 10\n`;
    // Pointers to the same object as picture-0 that differ in size or name an extension.
    const zero = createHash('sha256').update(images[0] as Buffer).digest('hex');
    files['docs/img/wrong-size.png'] = `version https://git-lfs.github.com/spec/v1\noid sha256:${zero}\nsize ${(images[0] as Buffer).length + 1}\n`;
    files['docs/img/same-object-extension.png'] = `version https://git-lfs.github.com/spec/v1\next-0-zip sha256:${'d'.repeat(64)}\noid sha256:${zero}\nsize ${(images[0] as Buffer).length}\n`;
    // A pointer naming a transforming extension; its object is never fetched.
    files['docs/img/extension.png'] = `version https://git-lfs.github.com/spec/v1\next-0-zip sha256:${'d'.repeat(64)}\noid sha256:${'e'.repeat(64)}\nsize 10\n`;
    await fixture.seed(files, { lfs: ['docs/img/*.png'] });
  });
  after(async () => fixture.cleanup());

  it('clones without LFS content and downloads only the objects read', async () => {
    const git = await fixture.clone('lfs-reader');
    const { tracked } = await fetchState(git, config);
    assert.equal(await countLocalLfsObjects(git), 0, 'the clone holds no LFS objects');

    const wanted = ['docs/img/picture-1.png', 'docs/img/picture-3.png', 'docs/img/picture-4.png'];
    const files = await readFiles(git, config, tracked, wanted);
    for (const path of wanted) {
      const file = files.get(path);
      const index = Number(/picture-(\d)/.exec(path)?.[1]);
      assert.ok(file?.ok, `${path} is read`);
      assert.ok(file.ok && file.lfs && file.content.equals(images[index] as Buffer));
    }
    assert.equal(await countLocalLfsObjects(git), 3, 'exactly the three objects were downloaded');

    // Reading them again uses the local store.
    await readFiles(git, config, tracked, wanted.slice(0, 2));
    assert.equal(await countLocalLfsObjects(git), 3);
  });

  it('reads plain files as they are and reports what it cannot read', async () => {
    const git = await fixture.clone('plain-reader');
    const { tracked } = await fetchState(git, config);
    const files = await readFiles(git, config, tracked, ['docs/guide.md', 'plain/icon.gif', 'docs/img/missing.png', 'docs/none.md']);
    const guide = files.get('docs/guide.md');
    assert.ok(guide?.ok && !guide.lfs && guide.content.toString('utf8') === '# Guide\n');
    const icon = files.get('plain/icon.gif');
    assert.ok(icon?.ok && !icon.lfs && icon.content.equals(plainImage));
    const missing = files.get('docs/img/missing.png');
    assert.ok(missing !== undefined && !missing.ok && /LFS object/.test(missing.reason));
    const none = files.get('docs/none.md');
    assert.ok(none !== undefined && !none.ok && none.reason === 'not in the tree');
    assert.equal(await countLocalLfsObjects(git), 0);
  });

  it('reads LFS objects from the configured remote even when the branch tracks another', async () => {
    const git = await fixture.clone('lfs-other-remote');
    const { tracked } = await fetchState(git, config);
    const empty = join(fixture.root, 'empty.git');
    await fixture.remote.run(['init', '--quiet', '--bare', empty]);
    await git.run(['remote', 'add', 'other', pathToFileURL(empty).href]);
    await git.run(['config', 'branch.main.remote', 'other']);
    const files = await readFiles(git, config, tracked, ['docs/img/picture-5.png']);
    const file = files.get('docs/img/picture-5.png');
    assert.ok(file?.ok && file.content.equals(images[5] as Buffer), JSON.stringify(file?.ok ? 'ok' : file));
  });

  it('checks each pointer on its own when pointers share an object, in any order', async () => {
    const odd = ['docs/img/wrong-size.png', 'docs/img/same-object-extension.png'];
    for (const order of [['docs/img/picture-0.png', ...odd], [...odd, 'docs/img/picture-0.png']]) {
      const git = await fixture.clone(`shared-object-${order[0]?.length}`);
      const { tracked } = await fetchState(git, config);
      const files = await readFiles(git, config, tracked, order);
      const valid = files.get('docs/img/picture-0.png');
      assert.ok(valid?.ok && valid.content.equals(images[0] as Buffer), `valid pointer, order ${order.join(',')}`);
      for (const path of odd) assert.equal(files.get(path)?.ok, false, `${path}, order ${order.join(',')}`);
    }
  });

  it('refuses LFS pointers with extensions', async () => {
    const git = await fixture.clone('lfs-extension');
    const { tracked } = await fetchState(git, config);
    const files = await readFiles(git, config, tracked, ['docs/img/extension.png']);
    const file = files.get('docs/img/extension.png');
    assert.ok(file !== undefined && !file.ok && /extensions/.test(file.reason));
  });

  it('lists the tracked tree with sizes', async () => {
    const git = await fixture.clone('lister');
    const { tracked } = await fetchState(git, config);
    const entries = await listTree(git, tracked);
    const guide = entries.find((entry) => entry.path === 'docs/guide.md');
    assert.equal(guide?.size, '# Guide\n'.length);
    const hash = createHash('sha256').update(images[0] as Buffer).digest('hex');
    const pointer = entries.find((entry) => entry.path === 'docs/img/picture-0.png');
    const blob = (await readBlobs(git, [pointer?.oid as string])).get(pointer?.oid as string)?.toString('utf8');
    assert.ok(blob?.includes(hash), 'LFS files are pointers in git');
  });
});

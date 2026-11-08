// The state layer against a real GitHub repository. Runs only when
// MDBISYNC_TEST_SANDBOX_URL names a test repository the host's git
// credentials can push to. Each run uses its own branch and ref prefix and
// deletes them afterwards. The LFS objects it uploads (a few kilobytes of
// random bytes) stay in the repository's LFS storage.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Git, commitIds, commitTree, commitUploads, fetchState, pushAtomic, readFiles, resolveStateConfig, stateRef } from '../../src/state/index.ts';
import { countLocalLfsObjects } from '../../src/state/test-helpers.ts';

const url = process.env.MDBISYNC_TEST_SANDBOX_URL ?? '';
const run = randomBytes(3).toString('hex');
const identity = { name: 'State Test', email: 'state-test@example.com' };
const config = resolveStateConfig({ trackedBranch: `t/${run}/main`, syncBranch: `t/${run}/sync`, refPrefix: `refs/mdbisync-t/${run}` });
const refs = [stateRef(config, 'linear'), stateRef(config, 'ids'), stateRef(config, 'uploads')];

describe('state against the sandbox repository', { skip: url === '' ? 'MDBISYNC_TEST_SANDBOX_URL is not set' : false }, () => {
  let root: string;
  const images = Array.from({ length: 5 }, () => randomBytes(1500));

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'state-sandbox-'));
    const seed = new Git(join(root, 'seed'), {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    });
    await new Git(root).run(['init', '--quiet', '--initial-branch=main', seed.dir]);
    await seed.run(['lfs', 'install', '--local']);
    const files: Record<string, Buffer | string> = { '.gitattributes': 'img/*.png filter=lfs diff=lfs merge=lfs -text\n', 'notes/plan.md': '# Plan\n' };
    images.forEach((image, index) => (files[`img/figure-${index}.png`] = image));
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(seed.dir, path)), { recursive: true });
      await writeFile(join(seed.dir, path), content);
    }
    await seed.run(['add', '--all']);
    await seed.run(['commit', '--quiet', '-m', 'Seed']);
    await seed.run(['push', '--quiet', url, `HEAD:refs/heads/${config.trackedBranch}`], { env: { GIT_LFS_SKIP_SMUDGE: undefined } });
  });

  after(async () => {
    const cleaner = new Git(join(root, 'seed'));
    const doomed = [`refs/heads/${config.trackedBranch}`, ...refs];
    const present = (await cleaner.text(['ls-remote', '--refs', url, ...doomed])).split('\n').filter(Boolean).map((line) => line.split('\t')[1] as string);
    if (present.length > 0) await cleaner.run(['push', '--quiet', url, ...present.map((ref) => `:${ref}`)]);
    await rm(root, { recursive: true, force: true });
  });

  const clone = async (name: string): Promise<Git> => {
    await new Git(root).run(['clone', '--quiet', '--no-checkout', '--single-branch', '--branch', config.trackedBranch, url, join(root, name)]);
    return new Git(join(root, name));
  };

  it('lets exactly one of two writers win and leaves the other with nothing changed', async () => {
    const writers = [await clone('writer-a'), await clone('writer-b')];
    const fetched = await Promise.all(writers.map((git) => fetchState(git, config)));
    const nexts = await Promise.all(
      writers.map(async (git, index) => {
        const tracked = fetched[index]?.tracked as string;
        return [
          await commitTree(git, { parents: [tracked], base: tracked, changes: new Map([['notes/plan.md', `# Plan\n\nWriter ${index}.\n`]]), message: 'Record', identity }),
          await commitIds(git, null, new Map([['notes/plan.md', { id: `doc-${index}` }]]), identity),
          await commitUploads(git, null, new Map([['e'.repeat(64), `https://uploads.example.com/${index}`]]), identity),
        ];
      }),
    );
    const results = await Promise.all(
      writers.map((git, index) => pushAtomic(git, config, refs.map((ref, slot) => ({ ref, expected: null, next: nexts[index]?.[slot] as string })))),
    );
    assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
    const winner = results.findIndex((result) => result.ok);
    const loser = results[1 - winner];
    assert.ok(loser !== undefined && !loser.ok && loser.reason === 'stale', JSON.stringify(loser));

    const advertised = await new Git(root).text(['ls-remote', '--refs', url, ...refs]);
    const remote = new Map(advertised.split('\n').map((line) => line.split('\t').reverse() as [string, string]));
    refs.forEach((ref, slot) => assert.equal(remote.get(ref), nexts[winner]?.[slot], `${ref} holds the winner's value`));

    // A later push from the loser's stale view is refused as a whole.
    const late = await pushAtomic(writers[1 - winner] as Git, config, refs.map((ref, slot) => ({ ref, expected: null, next: nexts[1 - winner]?.[slot] as string })));
    assert.ok(!late.ok && late.reason === 'stale');
  });

  it('downloads only the LFS objects it reads', async () => {
    const git = await clone('reader');
    const { tracked } = await fetchState(git, config);
    const wanted = ['img/figure-0.png', 'img/figure-2.png', 'img/figure-4.png'];
    const files = await readFiles(git, config, tracked, wanted);
    for (const path of wanted) {
      const file = files.get(path);
      const index = Number(/figure-(\d)/.exec(path)?.[1]);
      assert.ok(file?.ok && file.lfs && file.content.equals(images[index] as Buffer), path);
    }
    assert.equal(await countLocalLfsObjects(git), 3);
  });
});

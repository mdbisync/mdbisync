import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Git, GitError } from '../../../src/state/index.ts';
import { fetchRef } from './checks.ts';
import type { RunContext } from './context.ts';
import { runNames } from './isolation.ts';
import { pullTracked } from './person-git.ts';
import { readRunIds } from './step-helpers.ts';

const IDENTITY = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
const roots: string[] = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A bare sandbox with the run's tracked branch, and a person's single-branch clone of it, as `Sandbox.clone` makes. */
async function personClone() {
  const root = mkdtempSync(join(tmpdir(), 'person-git-'));
  roots.push(root);
  const names = runNames('aaaaaa');
  const remote = join(root, 'sandbox.git');
  await new Git(root, IDENTITY).run(['init', '--quiet', '--bare', '--initial-branch=main', remote]);
  const seed = new Git(join(root, 'seed'), IDENTITY);
  await new Git(root, IDENTITY).run(['init', '--quiet', '--initial-branch=main', seed.dir]);
  writeFileSync(join(seed.dir, 'plan.md'), '# Plan\n');
  await seed.run(['add', '--all']);
  await seed.run(['commit', '--quiet', '-m', 'Starting tree']);
  await seed.run(['push', '--quiet', remote, `HEAD:refs/heads/${names.trackedBranch}`]);
  // The ids state ref, as the engine records it: a commit of its own, sharing no history with the branch.
  const blob = (await seed.text(['hash-object', '-w', '--stdin'], { input: '{}' })).trim();
  const tree = (await seed.text(['mktree'], { input: `100644 blob ${blob}\tids.json\n` })).trim();
  const ids = (await seed.text(['commit-tree', tree, '-m', 'ids'])).trim();
  await seed.run(['push', '--quiet', remote, `${ids}:${names.refPrefix}/ids`]);
  await new Git(root, IDENTITY).run(['clone', '--quiet', '--single-branch', '--branch', names.trackedBranch, remote, join(root, 'person')]);
  const runDir = join(root, 'run');
  mkdirSync(runDir);
  const lines: string[] = [];
  const git = new Git(join(root, 'person'), IDENTITY);
  const ctx = { names, runDir, log: (line: string) => void lines.push(line) };
  return { git, seed, remote, ctx, lines, person: async () => git };
}

/** A new commit on the tracked branch, as another writer pushes it. */
async function pushFromSeed(seed: Git, remote: string, branch: string, text: string) {
  writeFileSync(join(seed.dir, 'plan.md'), text);
  await seed.run(['commit', '--quiet', '-am', 'Update the review date']);
  await seed.run(['push', '--quiet', remote, `HEAD:refs/heads/${branch}`]);
}

const diagnosticsFiles = (runDir: string) => readdirSync(runDir).filter((name) => name.startsWith('person-git-'));

describe('the person clone pull', () => {
  it('pulls the tracked branch and writes no diagnostics when it works', async () => {
    const { git, seed, remote, ctx, lines } = await personClone();
    await pushFromSeed(seed, remote, ctx.names.trackedBranch, '# Plan\n\nMore.\n');
    await pullTracked(git, ctx);
    assert.equal(readFileSync(join(git.dir, 'plan.md'), 'utf8'), '# Plan\n\nMore.\n');
    assert.deepEqual(diagnosticsFiles(ctx.runDir), []);
    assert.deepEqual(lines, []);
  });

  it('neither the pull nor the state-ref reads use FETCH_HEAD, which concurrent fetches in the clone rewrite', async () => {
    const { git, seed, remote, ctx, person } = await personClone();
    // Any write to FETCH_HEAD now fails: a plain `git pull` cannot work here.
    mkdirSync(join(git.dir, '.git', 'FETCH_HEAD'));
    await assert.rejects(git.run(['pull', '--quiet', '--no-rebase', '--no-edit', 'origin', ctx.names.trackedBranch]), GitError);
    await pushFromSeed(seed, remote, ctx.names.trackedBranch, '# Plan\n\nAgain.\n');
    await pullTracked(git, ctx);
    assert.equal(readFileSync(join(git.dir, 'plan.md'), 'utf8'), '# Plan\n\nAgain.\n');
    assert.notEqual(await fetchRef(git, `${ctx.names.refPrefix}/ids`), null);
    assert.deepEqual(await readRunIds({ ...ctx, person } as unknown as RunContext), new Map());
  });

  it('keeps pulling the tracked branch while Linear edits read the ids ref in the same clone (the live burst race)', async () => {
    const { git, seed, remote, ctx, person } = await personClone();
    const reader = { ...ctx, person } as unknown as RunContext;
    let reading = true;
    // Each burst Linear edit reads the ids ref: a stream of state-ref fetches into the person's clone.
    const reads = (async () => { while (reading) await readRunIds(reader); })();
    try {
      for (let round = 0; round < 15; round += 1) {
        await pushFromSeed(seed, remote, ctx.names.trackedBranch, `# Plan\n\nRound ${round}.\n`);
        await pullTracked(git, ctx);
        assert.equal(readFileSync(join(git.dir, 'plan.md'), 'utf8'), `# Plan\n\nRound ${round}.\n`);
      }
    } finally {
      reading = false;
      await reads;
    }
    assert.deepEqual(diagnosticsFiles(ctx.runDir), []);
  });

  it('keeps what explains a pull that refuses unrelated histories, and names the file in the error', async () => {
    const { git, ctx, lines } = await personClone();
    // The person's branch ends up on a history of its own (as in the live L4-12 burst): the next pull cannot merge.
    await git.run(['checkout', '--quiet', '--orphan', 'elsewhere']);
    await git.run(['commit', '--quiet', '-m', 'Unrelated root']);
    await git.run(['branch', '--quiet', '-f', ctx.names.trackedBranch, 'HEAD']);
    await git.run(['checkout', '--quiet', ctx.names.trackedBranch]);
    const error = await pullTracked(git, ctx).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof GitError, String(error));
    assert.match(error.stderr, /refusing to merge unrelated histories/);
    const files = diagnosticsFiles(ctx.runDir);
    assert.equal(files.length, 1);
    const file = join(ctx.runDir, files[0]!);
    assert.match(error.stderr, new RegExp(`diagnostics: ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(lines.some((line) => line.includes(file)), lines.join(' | '));
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^reason: merge .*refusing to merge unrelated histories/);
    // No merge base, two different roots, and the reflog that shows how HEAD got there.
    assert.match(text, /\$ git merge-base --all HEAD refs\/remotes\/origin\/t\/aaaaaa\/main\nexit 1/);
    const roots = [...text.matchAll(/\$ git rev-list --max-parents=0 (?:HEAD|refs\/remotes\/origin\/t\/aaaaaa\/main)\nexit 0\n([0-9a-f]{40})/g)].map((match) => match[1]);
    assert.equal(roots.length, 2);
    assert.notEqual(roots[0], roots[1]);
    assert.match(text, /\$ git reflog -20 --date=iso\nexit 0\n[\s\S]*Unrelated root/);
    assert.match(text, /\$ git ls-remote origin refs\/heads\/t\/aaaaaa\/main\nexit 0\n[0-9a-f]{40}\trefs\/heads\/t\/aaaaaa\/main/);
    assert.match(text, /objects\/info\/alternates: none/);
  });
});

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Git, GitError } from '../../../src/state/index.ts';
import { fetchRef } from './checks.ts';
import type { RunContext } from './context.ts';
import { runNames } from './isolation.ts';
import { finishPersonClone, pullTracked, redactCredentials, withoutCredentials, writePersonDiagnostics } from './person-git.ts';
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
    // The error names the file relative to the run folder: no local path goes into reports.
    assert.ok(error.stderr.endsWith(`(diagnostics: ${files[0]} in the run folder)`), error.stderr);
    assert.ok(!error.stderr.includes(ctx.runDir), error.stderr);
    assert.ok(lines.some((line) => line.includes(files[0]!)), lines.join(' | '));
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

  it('keeps the git failure when the diagnostics cannot be written', async () => {
    const { git, ctx } = await personClone();
    await git.run(['checkout', '--quiet', '--orphan', 'elsewhere']);
    await git.run(['commit', '--quiet', '-m', 'Unrelated root']);
    await git.run(['branch', '--quiet', '-f', ctx.names.trackedBranch, 'HEAD']);
    await git.run(['checkout', '--quiet', ctx.names.trackedBranch]);
    const error = await pullTracked(git, { ...ctx, runDir: join(ctx.runDir, 'missing') }).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof GitError, String(error));
    assert.match(error.stderr, /refusing to merge unrelated histories \(no diagnostics: /);
  });

  it('writes no credentials into the diagnostics', async () => {
    const { git, ctx } = await personClone();
    const file = await writePersonDiagnostics(git, ctx, 'fetch failed for https://person:s3cret-value@mirror.example/sandbox.git?access_token=abc123&x=1');
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes('s3cret-value') && !text.includes('abc123'), text.split('\n')[0]);
    assert.match(text, /^reason: fetch failed for https:\/\/\*\*\*@mirror\.example\/sandbox\.git\?access_token=\*\*\*&x=1/);
    // Two diagnostics in the same instant get two files.
    const again = await Promise.all([writePersonDiagnostics(git, ctx, 'a'), writePersonDiagnostics(git, ctx, 'b')]);
    assert.notEqual(again[0], again[1]);
  });

  it('hides URL credentials and token-like query values', () => {
    assert.equal(redactCredentials('https://user:pass@host/repo.git'), 'https://***@host/repo.git');
    assert.equal(redactCredentials('see https://person:token@example.com/o/r and ?sig=zzz&ok=1'), 'see https://***@example.com/o/r and ?sig=***&ok=1');
    assert.equal(redactCredentials('no secrets here: refs/heads/t/aaaaaa/main'), 'no secrets here: refs/heads/t/aaaaaa/main');
    assert.equal(withoutCredentials('https://user:pass@host/repo.git?access_token=abc'), 'https://host/repo.git');
    assert.equal(withoutCredentials('/srv/sandbox.git'), '/srv/sandbox.git');
    assert.equal(withoutCredentials('git@host:org/repo.git'), 'git@host:org/repo.git');
  });
});

describe('the person clone at the end of a run', () => {
  it('stays for diagnosis only after a failed run', async () => {
    for (const result of ['fail', 'pass', 'expected-red', 'env-blocked'] as const) {
      const root = mkdtempSync(join(tmpdir(), 'person-end-'));
      roots.push(root);
      await new Git(root).run(['init', '--quiet', join(root, 'person')]);
      const lines: string[] = [];
      finishPersonClone(root, result, (line) => void lines.push(line));
      assert.equal(existsSync(join(root, 'person')), result === 'fail', result);
      assert.equal(lines.some((line) => line.startsWith('kept the person clone for diagnosis')), result === 'fail', result);
    }
    // A run that never made the clone has nothing to keep or remove.
    const empty = mkdtempSync(join(tmpdir(), 'person-end-'));
    roots.push(empty);
    finishPersonClone(empty, 'fail', () => assert.fail('nothing to keep'));
  });

  it('keeps a failed run\'s clone without credentials and without depending on the shared cache', async () => {
    const root = mkdtempSync(join(tmpdir(), 'person-end-'));
    roots.push(root);
    const names = runNames('aaaaaa');
    const seed = new Git(join(root, 'seed'), IDENTITY);
    await new Git(root, IDENTITY).run(['init', '--quiet', '--initial-branch=main', seed.dir]);
    writeFileSync(join(seed.dir, 'plan.md'), '# Plan\n');
    await seed.run(['add', '--all']);
    await seed.run(['commit', '--quiet', '-m', 'Starting tree']);
    const remote = join(root, 'sandbox.git');
    await new Git(root, IDENTITY).run(['clone', '--quiet', '--bare', seed.dir, remote]);
    await new Git(remote).run(['branch', names.trackedBranch, 'main']);
    // As `Sandbox.clone` makes it: borrowing objects from a shared cache.
    const cache = join(root, 'cache.git');
    await new Git(root, IDENTITY).run(['clone', '--quiet', '--bare', remote, cache]);
    const runDir = join(root, 'run');
    await new Git(root, IDENTITY).run(['clone', '--quiet', '--reference-if-able', cache, '--single-branch', '--branch', names.trackedBranch, remote, join(runDir, 'person')]);
    const person = new Git(join(runDir, 'person'), IDENTITY);
    assert.ok(existsSync(join(person.dir, '.git', 'objects', 'info', 'alternates')));
    await person.run(['config', 'remote.origin.url', 'https://person:s3cret@mirror.example/sandbox.git?access_token=abc']);
    // Git also records the URL it cloned or fetched from, query and all, in the reflogs and FETCH_HEAD.
    const head = await person.text(['rev-parse', 'HEAD']);
    const headLog = join(person.dir, '.git', 'logs', 'HEAD');
    writeFileSync(headLog, `${readFileSync(headLog, 'utf8')}${head} ${head} T <t@example.com> 1 +0000\tclone: from https://mirror.example/sandbox.git?access_token=abc\n`);
    const fetchHead = join(person.dir, '.git', 'FETCH_HEAD');
    writeFileSync(fetchHead, `${head}\t\tbranch 't/aaaaaa/main' of https://mirror.example/sandbox.git?access_token=abc\n`);
    const lines: string[] = [];
    finishPersonClone(runDir, 'fail', (line) => void lines.push(line));
    assert.ok(lines.some((line) => line.startsWith('kept the person clone for diagnosis')), lines.join(' | '));
    assert.equal(await person.text(['config', '--get', 'remote.origin.url']), 'https://mirror.example/sandbox.git');
    assert.ok(!readFileSync(join(person.dir, '.git', 'config'), 'utf8').includes('s3cret'));
    for (const file of [headLog, join(person.dir, '.git', 'logs', 'refs', 'heads', 't', 'aaaaaa', 'main'), fetchHead]) {
      const text = readFileSync(file, 'utf8');
      assert.ok(!text.includes('access_token=abc'), `${file}: ${text}`);
    }
    assert.match(readFileSync(headLog, 'utf8'), /clone: from https:\/\/mirror\.example\/sandbox\.git\?access_token=\*\*\*/);
    // The cache may go; the kept clone still reads its whole history.
    rmSync(cache, { recursive: true, force: true });
    assert.equal(existsSync(join(person.dir, '.git', 'objects', 'info', 'alternates')), false);
    await person.run(['fsck', '--connectivity-only', '--no-progress']);
    assert.equal(await person.text(['log', '-1', '--format=%s']), 'Starting tree');
  });
});

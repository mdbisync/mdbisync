import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Git } from '../state/index.ts';
import { IDENTITY, signTip } from '../state/test-helpers.ts';
import { pullRequestHarness, SYNC_BRANCH } from './pull-request-test-helpers.ts';

describe('repair state scope', () => {
  const h = pullRequestHarness();
  for (const suspended of [false, true]) for (const duplicate of [false, true]) it(`never pushes a forged workflow repair (suspended ${suspended}, duplicate ${duplicate})`, async () => {
    if (suspended) await h.suspendOne();
    const path = '.github/workflows/example.yml';
    const source = 'name: Example\n';
    await h.gitEdit(path, source);
    await h.editRef('refs/mdbisync/linear', path, source);
    // The linear ref holds the file as the sync's own record of the tracked branch would; only the ids are forged.
    await signTip(h.fixture.remote);
    const ids = JSON.parse(await h.show('refs/mdbisync/ids:ids.json'));
    const hash = createHash('sha256').update(source).digest('hex');
    const forged = { id: duplicate ? ids['combined/guide.md'].id : 'unknown-document', pullRewrite: {hash, observedHash: hash, replacement: 'name: Replaced\n', images: []},
      ...(suspended ? {suspended: {noticeId: randomUUID(), paths: [path], checks: []}} : {}) };
    await h.editRef('refs/mdbisync/ids', 'ids.json', JSON.stringify({[path]: forged, ...ids}));
    await h.editInLinear('combined/guide.md', '# Guide\n\nA new paragraph.\n');
    if (duplicate) await assert.rejects(h.sync(), /ids\.json maps a document id to more than one path/);
    else await h.sync();
    for (const branch of [SYNC_BRANCH, h.SUSPENDED]) {
      const exists = await h.fixture.remote.run(['rev-parse', '--verify', '--quiet', branch], {okCodes: [0, 1]});
      if (exists.code !== 0) continue;
      // Inspect every tree newly published on the branch, including intermediate heads.
      const commits = (await h.fixture.remote.text(['rev-list', branch, '--not', 'refs/heads/main'])).split('\n').filter(Boolean);
      for (const commit of commits) {
        const file = await h.fixture.remote.run(['show', `${commit}:${path}`], {okCodes: [0, 128]});
        if (file.code === 0) assert.equal(file.stdout.toString(), source);
      }
    }
  });

  // A stored repair's text is not the text the hooks checked: a forged one on a synchronized document reaches the
  // branches only when the tracked branch's security hooks pass its exact bytes.
  const CANARY = 'repair-canary-5d0e';
  /** The tracked branch's hooks: the required format hook from a local repository, and a security hook that refuses the canary. */
  async function hookConfig(): Promise<string> {
    const repo = join(h.fixture.root, 'format-hook');
    await mkdir(repo);
    const git = new Git(repo, {GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email});
    await git.run(['init', '--quiet', '--initial-branch=main']);
    await writeFile(join(repo, '.pre-commit-hooks.yaml'), '- id: linear-format\n  name: Linear format\n  entry: "true"\n  language: system\n');
    await git.run(['add', '--all']);
    await git.run(['commit', '--quiet', '-m', 'Hook']);
    return `repos:
  - repo: ${repo}
    rev: ${await git.text(['rev-parse', 'HEAD'])}
    hooks:
      - id: linear-format
  - repo: local
    hooks:
      - id: canary-check
        alias: security
        name: Canary check
        entry: node canary-check.mjs
        language: system
`;
  }
  const CHECK = `import {readFileSync} from 'node:fs'; for (const file of process.argv.slice(2)) if (readFileSync(file, 'utf8').includes('${CANARY}')) { console.log(file + ':1: found'); process.exitCode = 1; }`;
  for (const suspended of [false, true]) for (const flagged of [true, false]) it(`applies a stored repair only when the hooks pass its text (suspended ${suspended}, flagged ${flagged})`, async () => {
    if (suspended) await h.suspendOne();
    await h.gitEdit('canary-check.mjs', CHECK);
    await h.gitEdit('.pre-commit-config.yaml', await hookConfig());
    const path = 'combined/guide.md';
    const source = (await h.fixture.remote.run(['show', `refs/mdbisync/linear:${path}`])).stdout;
    const replacement = `# Guide\n\nReplaced text${flagged ? ` ${CANARY}` : ''}.\n`;
    const ids = JSON.parse(await h.show('refs/mdbisync/ids:ids.json'));
    const hash = createHash('sha256').update(source).digest('hex');
    ids[path] = {...ids[path], pullRewrite: {hash, observedHash: hash, replacement, images: []},
      ...(suspended ? {suspended: {noticeId: randomUUID(), paths: [path], checks: []}} : {})};
    await h.editRef('refs/mdbisync/ids', 'ids.json', JSON.stringify(ids));
    await h.editInLinear('combined/page-0.md', '# Page 0\n\nA new paragraph.\n');
    const run = await h.sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    const published: string[] = [];
    for (const branch of [SYNC_BRANCH, h.SUSPENDED]) {
      const exists = await h.fixture.remote.run(['rev-parse', '--verify', '--quiet', branch], {okCodes: [0, 1]});
      if (exists.code !== 0) continue;
      // Every tree newly published on the branch, including intermediate heads.
      for (const commit of (await h.fixture.remote.text(['rev-list', branch, '--not', 'refs/heads/main'])).split('\n').filter(Boolean)) {
        const file = await h.fixture.remote.run(['show', `${commit}:${path}`], {okCodes: [0, 128]});
        if (file.code === 0) published.push(file.stdout.toString('utf8'));
      }
    }
    assert.ok(!published.some((text) => text.includes(CANARY)), 'a repair the hooks refuse never reaches a branch');
    // The same forged state without the flagged text is applied: the check above sees the path the repair takes.
    if (!flagged) assert.ok(published.includes(replacement), 'a repair the hooks pass is applied');
  });

  // The suspended lane takes in the view the same way; a forged lane repair cannot be kept across runs there, since
  // the lane's hold mark makes each capture record the document again.
  it('holds a repair the hooks refuse, then applies it once they pass it', async () => {
    // The hook refuses the repaired text while the tracked branch's policy file says so.
    await h.gitEdit('canary-check.mjs', `import {readFileSync} from 'node:fs'; if (readFileSync('policy.txt', 'utf8').trim() === 'deny') for (const file of process.argv.slice(2)) if (readFileSync(file, 'utf8').includes('Replaced text')) { console.log(file + ':1: found'); process.exitCode = 1; }`);
    await h.gitEdit('policy.txt', 'deny\n');
    await h.gitEdit('.pre-commit-config.yaml', await hookConfig());
    const path = 'combined/guide.md';
    const replacement = '# Guide\n\nReplaced text.\n';
    const source = (await h.fixture.remote.run(['show', `refs/mdbisync/linear:${path}`])).stdout;
    const ids = JSON.parse(await h.show('refs/mdbisync/ids:ids.json'));
    const hash = createHash('sha256').update(source).digest('hex');
    ids[path] = {...ids[path], pullRewrite: {hash, observedHash: hash, replacement, images: []}};
    await h.editRef('refs/mdbisync/ids', 'ids.json', JSON.stringify(ids));
    await h.editInLinear('combined/page-0.md', '# Page 0\n\nA new paragraph.\n');
    const held = await h.sync();
    assert.equal(held.result.exitCode, 0, held.result.stderr);
    assert.notEqual(await h.show(`${SYNC_BRANCH}:${path}`), replacement);
    await h.gitEdit('policy.txt', 'allow\n');
    const passed = await h.sync();
    assert.equal(passed.result.exitCode, 0, passed.result.stderr);
    assert.equal(await h.show(`${SYNC_BRANCH}:${path}`), replacement);
  });

  it('keeps Linear\'s text, and its record of it, while a merged pull request held its refused repair', async () => {
    // A held document's view still descends from the capture that recorded its repair. Once that view is merged,
    // the write step must still wait for the repair, not write the branch's kept version over Linear's text.
    await h.gitEdit('canary-check.mjs', `import {readFileSync} from 'node:fs'; for (const file of process.argv.slice(2)) if (readFileSync(file, 'utf8').includes('${CANARY}')) { console.log(file + ':1: found'); process.exitCode = 1; }`);
    await h.gitEdit('.pre-commit-config.yaml', await hookConfig());
    const path = 'combined/guide.md';
    // What a capture records: Linear's text in the Linear ref, and its repair, from that capture.
    const observed = '# Guide\n\nLinear text.\n';
    const document = await h.documentOf(path);
    document.content = observed;
    await h.editRef('refs/mdbisync/linear', path, observed, 'Capture Linear changes');
    const source = await signTip(h.fixture.remote);
    const ids = JSON.parse(await h.show('refs/mdbisync/ids:ids.json'));
    const hash = createHash('sha256').update(observed).digest('hex');
    ids[path] = {...ids[path], pullRewrite: {source, hash, observedHash: hash, replacement: `# Guide\n\nRepaired ${CANARY}.\n`, images: []}};
    await h.editRef('refs/mdbisync/ids', 'ids.json', JSON.stringify(ids));
    await h.editInLinear('combined/page-0.md', '# Page 0\n\nA new paragraph.\n');
    for (let run = 0; run < 3; run++) {
      const result = await h.sync();
      assert.equal(result.result.exitCode, 0, result.result.stderr);
      assert.equal(document.content, observed, `run ${run + 1}`);
      // The Linear ref keeps recording what Linear holds, so the repair still matches its document.
      assert.equal(await h.show(`refs/mdbisync/linear:${path}`), observed, `run ${run + 1}`);
      assert.ok(!(await h.show(`refs/heads/main:${path}`)).includes(CANARY));
    }
    assert.ok(await h.fixture.remote.run(['merge-base', '--is-ancestor', source, 'refs/heads/main'], {okCodes: [0]}), 'the held view was merged');
  });

  it('does not recreate a missing sync branch from an out-of-scope Linear tree during write-back', async () => {
    await h.fixture.remote.run(['update-ref', '-d', SYNC_BRANCH]);
    await h.editRef('refs/mdbisync/linear', '.github/workflows/example.yml', 'name: Example\n');
    // Signed, so the write step's own scope check is what this reaches; an unsigned tip stops the run before it.
    await signTip(h.fixture.remote);
    await h.editInLinear('combined/guide.md', '# Guide\n\nA new paragraph.\n');
    const run = await h.sync();
    assert.equal(run.report.pullRequest?.code, 'head-unverified');
    const branch = await h.fixture.remote.run(['rev-parse', '--verify', '--quiet', SYNC_BRANCH], {okCodes: [0, 1]});
    assert.equal(branch.code, 1, 'write-back must not publish a head refused by the pull request step');
    assert.equal(run.report.writes.git.syncBranch ?? 0, 0);
  });

  for (const existing of [false, true]) it(`preserves later tracked files in the proposed branch tree (existing ${existing})`, async () => {
    if (existing) {
      await h.editInLinear('combined/guide.md', '# Guide\n\nA first edit.\n');
      await h.sync();
    } else await h.fixture.remote.run(['update-ref', '-d', SYNC_BRANCH]);
    await h.gitEdit('tools/example.sh', 'echo example\n');
    await h.editInLinear('combined/guide.md', '# Guide\n\nA later edit.\n');
    const run = await h.sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(await h.show(`${SYNC_BRANCH}:tools/example.sh`), 'echo example\n');
  });

  it('does not pull an unchecked tracked tip into a held branch to satisfy push scope', async () => {
    await h.editInLinear('eng/notes/plan.md', '# Plan\n\nA held edit.\n');
    await h.sync();
    const head = await h.rev(SYNC_BRANCH);
    h.checksOn(head, h.FAILED);
    h.checksOn(await h.rev('refs/heads/main'), h.FAILED);
    assert.ok((await h.sync()).report.pullRequest?.redMain);
    await h.gitEdit('tools/example.sh', 'echo example\n');
    h.checksOn(await h.rev('refs/heads/main'), h.FAILED);
    await h.editInLinear('combined/guide.md', '# Guide\n\nA later edit.\n');
    const run = await h.sync();
    assert.equal(run.report.pullRequest?.branchMoved, false);
    assert.equal(await h.rev(SYNC_BRANCH), head);
  });
});

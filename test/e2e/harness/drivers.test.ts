import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Git } from '../../../src/state/index.ts';
import { checkpoint, CHECKPOINTS, HOOKS_DIR_ENV, HOOKS_ENV, hooksDir, testStopAfterDocuments } from '../../../src/test-hooks.ts';
import { CheckpointControl } from './checkpoints.ts';
import { annotatedFolders, buildRunTree, readAnnotation } from './corpus.ts';
import { engineInputs, inputEnv, runEngine, startEngine } from './engine.ts';
import { operationOf, startFaultProxy } from './fault-proxy.ts';
import { runNames } from './isolation.ts';
import { Sandbox } from './sandbox.ts';

const roots: string[] = [];
const fresh = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
};
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('engine checkpoints (MDBISYNC_TEST_HOOKS)', () => {
  it('do nothing and touch no file when hooks are off', async () => {
    const dir = fresh('hooks-off-');
    await checkpoint('before-write', { [HOOKS_DIR_ENV]: dir });
    assert.equal(existsSync(join(dir, 'reached')), false);
    assert.equal(hooksDir({ [HOOKS_DIR_ENV]: dir }), null);
    assert.equal(testStopAfterDocuments({ MDBISYNC_TEST_STOP_AFTER_DOCUMENTS: '80' }), undefined);
    assert.equal(testStopAfterDocuments({ [HOOKS_ENV]: '1', MDBISYNC_TEST_STOP_AFTER_DOCUMENTS: '80' }), 80);
    assert.throws(() => hooksDir({ [HOOKS_ENV]: '1', [HOOKS_DIR_ENV]: 'relative' }), /absolute/);
  });

  // A stub engine: a process that passes the checkpoints in order, like the engine will.
  const stub = `
    const { checkpoint, CHECKPOINTS } = await import(${JSON.stringify(new URL('../../../src/test-hooks.ts', import.meta.url).href)});
    for (const name of CHECKPOINTS) await checkpoint(name);
    process.stdout.write('done\\n');
  `;
  const startStub = (dir: string) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', stub], { env: { ...process.env, [HOOKS_ENV]: '1', [HOOKS_DIR_ENV]: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    return { child, exited };
  };

  it('pause an engine at a checkpoint until the harness resumes it', async () => {
    const control = new CheckpointControl(fresh('hooks-pause-'));
    control.pause('before-write');
    const { exited } = startStub(control.dir);
    assert.equal(await control.waitReached('before-write', { timeoutMs: 10_000, exited }), true);
    // Still paused: the next checkpoint is not reached.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(control.reached('after-write-before-record'), 0);
    control.resume('before-write');
    assert.equal(await exited, 0);
    for (const name of CHECKPOINTS) assert.equal(control.reached(name), 1, name);
  });

  it('forget an earlier engine\'s visit when a pause is armed', async () => {
    const control = new CheckpointControl(fresh('hooks-again-'));
    const first = startStub(control.dir);
    assert.equal(await first.exited, 0);
    assert.equal(control.reached('before-write'), 1);
    control.pause('before-write');
    assert.equal(control.reached('before-write'), 0);
    const second = startStub(control.dir);
    assert.equal(await control.waitReached('before-write', { timeoutMs: 10_000, exited: second.exited }), true);
    control.resume('before-write');
    assert.equal(await second.exited, 0);
  });

  it('let the harness kill an engine at a checkpoint', async () => {
    const control = new CheckpointControl(fresh('hooks-kill-'));
    control.pause('document-created-before-ids-push');
    const { child, exited } = startStub(control.dir);
    assert.equal(await control.waitReached('document-created-before-ids-push', { timeoutMs: 10_000, exited }), true);
    child.kill('SIGKILL');
    await exited;
    assert.equal(control.reached('after-reread-before-write'), 0);
  });
});

describe('engine driver', () => {
  it('passes the run inputs as MDBISYNC_ variables', () => {
    assert.equal(inputEnv('state-ref-prefix'), 'MDBISYNC_STATE_REF_PREFIX');
    const env = engineInputs({
      command: 'initial-sync', names: runNames('4f1a9c'), direction: 'git-to-linear', confirm: true, cwd: '/', repository: 'o/r',
      hooksDir: '/h', reportFile: '/r.json', summaryFile: '/s.md', linearUrl: 'http://127.0.0.1:1',
      credentials: { linearClientId: 'id', linearClientSecret: 'secret', githubToken: 'token' }, extraEnv: {}, timeoutMs: 1000,
    });
    assert.equal(env['MDBISYNC_TRACKED_BRANCH'], 't/4f1a9c/main');
    assert.equal(env['MDBISYNC_SYNC_BRANCH'], 't/4f1a9c/sync');
    assert.equal(env['MDBISYNC_STATE_REF_PREFIX'], 'refs/mdbisync-t/4f1a9c');
    assert.equal(env['MDBISYNC_LINEAR_API_URL'], 'http://127.0.0.1:1');
    assert.equal(env['MDBISYNC_DIRECTION'], 'git-to-linear');
    assert.equal(env['MDBISYNC_CONFIRM'], 'true');
  });

  it('recognizes a command that answers "not implemented", and only that answer', async () => {
    // Stub engines, so the test does not depend on which commands the real engine has implemented.
    const dir = fresh('engine-');
    const call = {
      command: 'sync' as const, names: runNames('4f1a9c'), cwd: dir, repository: 'o/r', hooksDir: dir, reportFile: join(dir, 'r.json'), summaryFile: join(dir, 's.md'),
      linearUrl: 'http://127.0.0.1:1', credentials: { linearClientId: '', linearClientSecret: '', githubToken: '' }, extraEnv: {}, timeoutMs: 30_000,
    };
    const stub = (name: string, script: string) => {
      const file = join(dir, name);
      writeFileSync(file, script);
      return { ...process.env, MDBISYNC_ENGINE: file };
    };
    const notImplemented = await runEngine(call, stub('not-implemented.mjs', "process.stderr.write('sync: not implemented\\n');\nprocess.exitCode = 10;\n"));
    assert.equal(notImplemented.notImplemented, true);
    assert.equal(notImplemented.timedOut, false);
    // Another failure with the same words elsewhere, or another exit code, is not that answer.
    const refused = await runEngine(call, stub('refused.mjs', "process.stderr.write('run initial sync first\\n');\nprocess.exitCode = 4;\n"));
    assert.equal(refused.notImplemented, false);
    const otherCode = await runEngine(call, stub('other-code.mjs', "process.stderr.write('sync: not implemented\\n');\nprocess.exitCode = 1;\n"));
    assert.equal(otherCode.notImplemented, false);
  });

  it('kills an engine that runs too long', async () => {
    const dir = fresh('engine-slow-');
    const slow = join(dir, 'slow.mjs');
    writeFileSync(slow, 'setTimeout(() => {}, 60_000);\n');
    const running = startEngine({
      command: 'sync', names: runNames('4f1a9c'), cwd: dir, repository: 'o/r', hooksDir: dir, reportFile: join(dir, 'r.json'), summaryFile: join(dir, 's.md'),
      linearUrl: 'http://127.0.0.1:1', credentials: { linearClientId: '', linearClientSecret: '', githubToken: '' }, extraEnv: {}, timeoutMs: 300,
    }, { ...process.env, MDBISYNC_ENGINE: slow });
    const result = await running.done;
    assert.equal(result.timedOut, true);
    assert.equal(result.notImplemented, false);
  });
});

describe('fault proxy', () => {
  async function upstream() {
    let calls = 0;
    const server = createServer((request, response) => {
      calls += 1;
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json', 'x-ratelimit-requests-remaining': '4000' });
        response.end(JSON.stringify({ data: { ok: true } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls: () => calls, close: () => new Promise((resolve) => server.close(resolve)) };
  }
  const post = (url: string, query: string) =>
    fetch(`${url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, operationName: /(?:query|mutation) (\w+)/.exec(query)?.[1] }) });

  it('names operations without keeping bodies', () => {
    assert.deepEqual(operationOf(JSON.stringify({ query: 'mutation UpdateDocument($id: String!) { x }' })), { operation: 'UpdateDocument', kind: 'mutation' });
    assert.deepEqual(operationOf(JSON.stringify({ query: '{ viewer { id } }' })), { operation: 'anonymous', kind: 'query' });
    assert.deepEqual(operationOf('not json'), { operation: 'unparsed', kind: 'other' });
  });

  it('forwards requests and counts them by kind', async () => {
    const up = await upstream();
    const proxy = await startFaultProxy(up.url);
    try {
      assert.equal((await post(proxy.url, 'query Q { a }')).status, 200);
      assert.equal((await post(proxy.url, 'mutation M { a }')).status, 200);
      assert.deepEqual(proxy.counts(), { total: 2, queries: 1, mutations: 1, injected: 0 });
      assert.equal(up.calls(), 2);
    } finally {
      await proxy.close();
      await up.close();
    }
  });

  it('answers the n-th request with 429 and Retry-After, then lets requests through', async () => {
    const up = await upstream();
    const proxy = await startFaultProxy(up.url);
    try {
      proxy.setFaults([{ kind: 'http', status: 429, requestNumber: 3, retryAfterSeconds: 2, times: 1 }]);
      const statuses = [];
      for (let i = 0; i < 4; i += 1) {
        const response = await post(proxy.url, 'query Q { a }');
        statuses.push([response.status, response.headers.get('retry-after')]);
      }
      assert.deepEqual(statuses, [[200, null], [200, null], [429, '2'], [200, null]]);
      assert.equal(up.calls(), 3);
    } finally {
      await proxy.close();
      await up.close();
    }
  });

  it('resets the connection of a document write, reports low budget, rejects a named document and fails uploads', async () => {
    const up = await upstream();
    const proxy = await startFaultProxy(up.url);
    try {
      proxy.setFaults([{ kind: 'write-error', variant: 'reset', times: 1 }]);
      await assert.rejects(post(proxy.url, 'mutation UpdateDocument { a }'));
      assert.equal((await post(proxy.url, 'mutation UpdateDocument { a }')).status, 200);

      proxy.setFaults([{ kind: 'budget-headers', remaining: 7, includeEndpointLimits: true }]);
      const low = await post(proxy.url, 'query Q { a }');
      assert.equal(low.headers.get('x-ratelimit-requests-remaining'), '7');
      assert.equal(low.headers.get('x-ratelimit-endpoint-requests-remaining'), '7');
      // A forwarded request with rewritten headers is still a real request (I9 counts it).
      assert.equal(proxy.requests.at(-1)?.injected, false);

      proxy.setFaults([{ kind: 'reject-document', target: 'weekly-plan' }]);
      const rejected = await fetch(`${proxy.url}/graphql`, { method: 'POST', body: JSON.stringify({ query: 'mutation CreateDocument { a }', operationName: 'CreateDocument', variables: { input: { title: 'notes/weekly-plan' } } }) });
      assert.match(await rejected.text(), /INPUT_ERROR/);
      assert.equal((await post(proxy.url, 'mutation CreateDocument { other }')).status, 200);

      proxy.setFaults([{ kind: 'upload-error', times: 1 }]);
      assert.equal((await post(proxy.url, 'mutation FileUpload { a }')).status, 500);
      assert.ok(proxy.counts().injected >= 3);
    } finally {
      await proxy.close();
      await up.close();
    }
  });
});

// --- the corpus layout and the sandbox, against a local bare repository --------

const README = (fields: string) => `---\n${fields}\n---\n# Area\n`;
const CORPUS: Record<string, string> = {
  'README.md': '# Corpus\n',
  'eng/README.md': README('linear-team: ENG'),
  'eng/guides/start.md': '# Start\n\nkx-00000001\n',
  'eng/alpha/README.md': README('linear-project: PROJECT_ENG_1'),
  'eng/alpha/plan.md': '# Plan\n\nkx-00000002\n',
  'docs/README.md': README('linear-team: DOCS'),
  'docs/beta/README.md': README('linear-project: PROJECT_DOCS_1'),
  'docs/beta/faq.md': '# FAQ\n\nkx-00000003\n',
  'combined/README.md': README('linear-team: DOCS\nlinear-project: PROJECT_COMBINED'),
  'combined/note.md': '# Note\n\nkx-00000004\n',
  '.gitattributes': '*.png filter=lfs diff=lfs merge=lfs -text\n',
  '.github/workflows/x.yml': 'on: push\n',
};

describe('run tree from a slice', () => {
  const readmes = new Map(Object.entries(CORPUS).filter(([path]) => path.endsWith('README.md')));

  it('reads annotations from front matter', () => {
    assert.deepEqual(readAnnotation(CORPUS['combined/README.md'] as string), { team: 'DOCS', project: 'PROJECT_COMBINED' });
    assert.equal(readAnnotation('# no front matter\n'), null);
    assert.equal(annotatedFolders(readmes).length, 5);
  });

  it('puts team-zone files below the run id, renames projects and leaves out workflows', () => {
    const names = runNames('4f1a9c');
    const tree = buildRunTree({ slice: 'mini', paths: Object.keys(CORPUS) }, readmes, names);
    assert.equal(tree.paths.get('eng/4f1a9c/guides/start.md'), 'eng/guides/start.md');
    assert.equal(tree.paths.get('eng/README.md'), 'eng/README.md');
    assert.equal(tree.paths.get('eng/alpha/plan.md'), 'eng/alpha/plan.md');
    assert.equal(tree.paths.get('combined/note.md'), 'combined/note.md');
    assert.equal([...tree.paths.keys()].some((path) => path.startsWith('.github/')), false);
    assert.equal(tree.projects.get('PROJECT_ENG_1'), 'Field notes 4f1a9c');
    assert.equal(tree.projects.get('PROJECT_DOCS_1'), 'Library index 4f1a9c');
    assert.match(tree.rewritten.get('eng/alpha/README.md') as string, /linear-project: Field notes 4f1a9c/);
    assert.deepEqual([...tree.teamZones], [['ENG', 'eng/4f1a9c']]);
    assert.throws(() => buildRunTree({ slice: 'mini', paths: ['x/README.md'] }, new Map([['x/README.md', README('linear-project: OTHER')]]), names), /unknown project placeholder/);
  });

  it('lays out the real corpus generator\'s slices', async () => {
    const { buildCorpus } = await import('../../corpus/generate.ts');
    const corpus = buildCorpus();
    const text = new Map(corpus.files.map((file) => [file.path, file.content.toString('utf8')]));
    const names = runNames('4f1a9c');
    for (const slice of ['mini', 'bank', 'mid', 'full'] as const) {
      const paths = corpus.slices[slice];
      const readmes = new Map(paths.filter((path) => /(^|\/)README\.md$/.test(path)).map((path) => [path, text.get(path) ?? '']));
      const tree = buildRunTree({ slice, paths }, readmes, names);
      assert.equal(tree.paths.size, paths.filter((path) => !path.startsWith('.github/')).length, slice);
      // Every project of the slice gets a run project, and only ENG has a team zone.
      for (const [target, readme] of tree.rewritten) assert.doesNotMatch(readme, /PROJECT_[A-Z]+/, `${slice} ${target}`);
      assert.deepEqual([...tree.teamZones.keys()], tree.teamZones.size === 0 ? [] : ['ENG'], slice);
      // No two corpus files land on one path.
      assert.equal(new Set(tree.paths.keys()).size, tree.paths.size, slice);
    }
    const mini = buildRunTree({ slice: 'mini', paths: corpus.slices.mini }, new Map(corpus.slices.mini.filter((p) => p.endsWith('README.md')).map((p) => [p, text.get(p) ?? ''])), names);
    assert.ok(mini.projects.size >= 3, 'mini maps three projects');
    assert.ok([...mini.paths.keys()].some((path) => path.startsWith('eng/4f1a9c/')), 'mini has team-zone documents below the run id');
  });

  it('builds and pushes a run branch from the sandbox main, and deletes only run refs', async () => {
    const root = fresh('sandbox-');
    const remote = join(root, 'sandbox.git');
    await new Git(root).run(['init', '--quiet', '--bare', '--initial-branch=main', remote]);
    const seed = new Git(join(root, 'seed'), { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' });
    await new Git(root).run(['init', '--quiet', '--initial-branch=main', seed.dir]);
    for (const [path, text] of Object.entries(CORPUS)) {
      mkdirSync(dirname(join(seed.dir, 'corpus', path)), { recursive: true });
      writeFileSync(join(seed.dir, 'corpus', path), text);
    }
    mkdirSync(join(seed.dir, 'corpus-slices'));
    writeFileSync(join(seed.dir, 'corpus-slices', 'mini.json'), JSON.stringify({ slice: 'mini', paths: Object.keys(CORPUS).sort() }));
    writeFileSync(join(seed.dir, 'corpus-slices', 'manifest.json'), JSON.stringify({ seed: 's', files: [] }));
    await seed.run(['add', '--all']);
    await seed.run(['commit', '--quiet', '-m', 'Corpus']);
    await seed.run(['push', '--quiet', remote, 'main']);

    const sandbox = new Sandbox({ url: remote, token: 'unused', stateDir: join(root, 'state'), runId: '4f1a9c' });
    await sandbox.refreshCache();
    const names = runNames('4f1a9c');
    const { commit } = await sandbox.createTrackedBranch('mini', names);
    const files = (await new Git(remote).text(['ls-tree', '-r', '--name-only', names.trackedBranch])).split('\n');
    assert.ok(files.includes('eng/4f1a9c/guides/start.md'));
    assert.ok(!files.some((file) => file.startsWith('corpus')));
    assert.equal((await new Git(remote).text(['rev-parse', `refs/heads/${names.trackedBranch}`])).trim(), commit);
    assert.match(await new Git(remote).text(['show', `${names.trackedBranch}:eng/alpha/README.md`]), /Field notes 4f1a9c/);
    await assert.rejects(sandbox.createTrackedBranch('full', names), /corpus-slices\/full\.json/);

    const clone = await sandbox.clone(names, join(root, 'person'));
    assert.ok(existsSync(join(clone.dir, 'eng/alpha/plan.md')));
    await new Git(remote).run(['update-ref', 'refs/mdbisync-t/4f1a9c/ids', commit]);
    await new Git(remote).run(['update-ref', 'refs/heads/t/aaaaaa/main', commit]);
    assert.deepEqual((await sandbox.runRefs()).map((ref) => ref.ref).sort(), ['refs/heads/t/4f1a9c/main', 'refs/heads/t/aaaaaa/main', 'refs/mdbisync-t/4f1a9c/ids']);
    await assert.rejects(sandbox.deleteRunRefs('4f1a9c', ['refs/heads/main']), /not a ref of run/);
    await sandbox.deleteRunRefs('4f1a9c', ['refs/heads/t/4f1a9c/main', 'refs/mdbisync-t/4f1a9c/ids']);
    assert.deepEqual((await sandbox.runRefs()).map((ref) => ref.ref), ['refs/heads/t/aaaaaa/main']);
    assert.notEqual(await sandbox.commitTime(commit), null);
  });
});

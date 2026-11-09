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
import { CHECK_WORKFLOW, CHECK_WORKFLOW_PATH } from '../../corpus/check-workflow.ts';
import { engineInputs, inputEnv, runEngine, startEngine } from './engine.ts';
import { operationOf, startFaultProxy, writeApplied, writeError, writeFields } from './fault-proxy.ts';
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
    assert.equal(control.reached('after-write-before-record'), 0);
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

  it('recognizes a command that answers "not implemented", and only that', async () => {
    const dir = fresh('engine-');
    const call = {
      command: 'sync' as const, names: runNames('4f1a9c'), cwd: dir, repository: 'o/r', hooksDir: dir, reportFile: join(dir, 'r.json'), summaryFile: join(dir, 's.md'),
      linearUrl: 'http://127.0.0.1:1', credentials: { linearClientId: '', linearClientSecret: '', githubToken: '' }, extraEnv: {}, timeoutMs: 30_000,
    };
    const stub = (body: string) => {
      const file = join(dir, `stub-${Math.random().toString(16).slice(2)}.mjs`);
      writeFileSync(file, body);
      return { ...process.env, MDBISYNC_ENGINE: file };
    };
    // A warning line may come before the stub's answer.
    const answered = await runEngine(call, stub("process.stderr.write('warning: x\\nsync: not implemented\\n'); process.exitCode = 10;\n"));
    assert.equal(answered.notImplemented, true);
    assert.equal(answered.timedOut, false);
    // A setup stop or an input error is a real outcome, not "not implemented".
    const stopped = await runEngine(call, stub("process.stderr.write('sync: stopped before any write (no-state)\\n'); process.exitCode = 4;\n"));
    assert.equal(stopped.notImplemented, false);
    assert.equal(stopped.exitCode, 4);
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

      proxy.setFaults([{ kind: 'reject-document', ids: ['doc-7f3a'], titles: ['weekly-plan'] }]);
      const rejected = await fetch(`${proxy.url}/graphql`, { method: 'POST', body: JSON.stringify({ query: 'mutation CreateDocument { a }', operationName: 'CreateDocument', variables: { input: { title: 'notes/weekly-plan' } } }) });
      assert.match(await rejected.text(), /INPUT_ERROR/);
      // An update that carries only the document's id is refused too.
      const update = await fetch(`${proxy.url}/graphql`, { method: 'POST', body: JSON.stringify({ query: 'mutation UpdateDocument { a }', operationName: 'UpdateDocument', variables: { id: 'doc-7f3a', input: { content: 'New text.' } } }) });
      assert.match(await update.text(), /INPUT_ERROR/);
      assert.equal((await post(proxy.url, 'mutation CreateDocument { other }')).status, 200);

      proxy.setFaults([{ kind: 'upload-error', times: 1 }]);
      assert.equal((await post(proxy.url, 'mutation FileUpload { a }')).status, 500);
      assert.ok(proxy.counts().injected >= 3);
    } finally {
      await proxy.close();
      await up.close();
    }
  });

  it('drops the answer of a write Linear has applied, only for the write it names', async () => {
    const up = await upstream();
    const proxy = await startFaultProxy(up.url);
    try {
      proxy.setFaults([{ kind: 'write-error', variant: 'reset-after-apply', operation: 'create', times: 1 }]);
      // An update passes: the fault names creates.
      assert.equal((await post(proxy.url, 'mutation UpdateDocument { a }')).status, 200);
      const before = up.calls();
      // The create reaches Linear, then the connection drops before its answer.
      await assert.rejects(post(proxy.url, 'mutation CreateDocument { a }'));
      assert.equal(up.calls(), before + 1);
      // Linear answered 200; the answer was dropped and the record says so.
      assert.equal(proxy.requests.at(-1)?.status, 200);
      assert.equal(proxy.requests.at(-1)?.answerDropped, true);
      // It was a real request, counted for I9.
      assert.equal(proxy.requests.at(-1)?.injected, false);
      // Once only.
      assert.equal((await post(proxy.url, 'mutation CreateDocument { a }')).status, 200);
      // A plain reset drops the write before Linear sees it.
      proxy.setFaults([{ kind: 'write-error', variant: 'reset', times: 1 }]);
      const calls = up.calls();
      await assert.rejects(post(proxy.url, 'mutation UpdateDocument { a }'));
      assert.equal(up.calls(), calls);
    } finally {
      await proxy.close();
      await up.close();
    }
  });

  it('rejects a document by its write fields only, before a lost-answer fault, and keeps that fault for a write that reaches Linear', async () => {
    assert.deepEqual(writeFields(JSON.stringify({ query: 'mutation UpdateDocument { a }', variables: { id: 'doc-1', input: { title: 'guides/plan', content: 'See weekly-plan.' } } })), { ids: ['doc-1'], titles: ['guides/plan'] });
    const up2 = await upstream();
    const proxy2 = await startFaultProxy(up2.url);
    const send2 = (variables: unknown, name = 'UpdateDocument') => fetch(`${proxy2.url}/graphql`, { method: 'POST', body: JSON.stringify({ query: `mutation ${name} { a }`, operationName: name, variables }) });
    try {
      proxy2.setFaults([{ kind: 'write-error', variant: 'reset-after-apply', times: 1 }, { kind: 'reject-document', ids: ['doc-1'], titles: ['weekly-plan'] }]);
      // The rejected document is refused even though a lost-answer fault comes first in the list; that fault stays armed.
      assert.match(await (await send2({ id: 'doc-1', input: { content: 'New text.' } })).text(), /INPUT_ERROR/);
      assert.match(await (await send2({ input: { title: 'notes/weekly-plan' } }, 'CreateDocument')).text(), /INPUT_ERROR/);
      // The next other write, whose content only mentions the name, is not rejected: it reaches Linear and loses its answer.
      await assert.rejects(send2({ id: 'doc-2', input: { content: 'Read weekly-plan first.' } }));
      assert.equal(proxy2.requests.at(-1)?.answerDropped, true);
      // Spent once: the next write is answered.
      assert.equal((await send2({ id: 'doc-2', input: { content: 'Again.' } })).status, 200);
    } finally {
      await proxy2.close();
      await up2.close();
    }
  });

  it('keeps a lost-answer fault armed while Linear refuses the write', async () => {
    let refuse = true;
    const proxy = await startFaultProxy('http://upstream.invalid', {
      fetch: async () => {
        // GraphQL refuses with HTTP 200 and errors; then a write that Linear applies.
        const body = refuse ? { data: null, errors: [{ message: 'refused', extensions: { code: 'INPUT_ERROR' } }] } : { data: { documentUpdate: { success: true } } };
        refuse = false;
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    try {
      proxy.setFaults([{ kind: 'write-error', variant: 'reset-after-apply', times: 1 }]);
      // The refusal reaches the engine as it is, and is no lost answer.
      const refused = await post(proxy.url, 'mutation UpdateDocument { a }');
      assert.match(await refused.text(), /refused/);
      assert.equal(proxy.requests.at(-1)?.answerDropped, undefined);
      // The next write is applied, and its answer is the one lost.
      await assert.rejects(post(proxy.url, 'mutation UpdateDocument { a }'));
      assert.equal(proxy.requests.at(-1)?.answerDropped, true);
    } finally {
      await proxy.close();
    }
    assert.equal(writeApplied(Buffer.from(JSON.stringify({ data: { documentCreate: { success: false } } }))), false);
    assert.equal(writeApplied(Buffer.from('not json')), false);
  });

  it('keeps a lost-answer fault armed when the write never reached Linear', async () => {
    let fail = true;
    const proxy = await startFaultProxy('http://upstream.invalid', {
      fetch: async () => {
        if (fail) {
          fail = false;
          throw new Error('network down');
        }
        return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    try {
      proxy.setFaults([{ kind: 'write-error', variant: 'reset-after-apply', times: 1 }]);
      assert.equal((await post(proxy.url, 'mutation UpdateDocument { a }')).status, 502);
      await assert.rejects(post(proxy.url, 'mutation UpdateDocument { a }'));
      assert.equal(proxy.requests.at(-1)?.answerDropped, true);
    } finally {
      await proxy.close();
    }
  });

  it('names write-error variants the way specs write them', async () => {
    // writeError lives next to the proxy's faults.
    assert.deepEqual(writeError('http-500'), { kind: 'write-error', variant: 'server-error', times: 1 });
    assert.deepEqual(writeError('connection-reset'), { kind: 'write-error', variant: 'reset', times: 1 });
    assert.deepEqual(writeError('reset-after-apply'), { kind: 'write-error', variant: 'reset-after-apply', times: 1 });
    assert.deepEqual(writeError('reset-after-apply-on-update'), { kind: 'write-error', variant: 'reset-after-apply', operation: 'update', times: 1 });
    assert.throws(() => writeError('surprise'), /unknown write-error variant/);
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
  [CHECK_WORKFLOW_PATH]: CHECK_WORKFLOW,
};

describe('run tree from a slice', () => {
  const readmes = new Map(Object.entries(CORPUS).filter(([path]) => path.endsWith('README.md')));

  it('reads annotations from front matter', () => {
    assert.deepEqual(readAnnotation(CORPUS['combined/README.md'] as string), { team: 'DOCS', project: 'PROJECT_COMBINED' });
    assert.equal(readAnnotation('# no front matter\n'), null);
    assert.equal(annotatedFolders(readmes).length, 5);
  });

  it('puts team-zone files below the run id, renames projects and excludes unrelated workflows', () => {
    const names = runNames('4f1a9c');
    const tree = buildRunTree({ slice: 'mini', paths: Object.keys(CORPUS) }, readmes, names);
    assert.equal(tree.paths.get('eng/4f1a9c/guides/start.md'), 'eng/guides/start.md');
    assert.equal(tree.paths.get('eng/README.md'), 'eng/README.md');
    assert.equal(tree.paths.get('eng/alpha/plan.md'), 'eng/alpha/plan.md');
    assert.equal(tree.paths.get('combined/note.md'), 'combined/note.md');
    assert.deepEqual([...tree.paths.keys()].filter((path) => path.startsWith('.github/')), [CHECK_WORKFLOW_PATH]);
    assert.equal(tree.projects.get('PROJECT_ENG_1'), 'Field notes 4f1a9c');
    assert.equal(tree.projects.get('PROJECT_DOCS_1'), 'Library index 4f1a9c');
    assert.match(tree.rewritten.get('eng/alpha/README.md') as string, /linear-project: Field notes 4f1a9c/);
    assert.deepEqual([...tree.teamZones], [['ENG', 'eng/4f1a9c']]);
    assert.throws(() => buildRunTree({ slice: 'mini', paths: ['x/README.md'] }, new Map([['x/README.md', README('linear-project: OTHER')]]), names), /unknown project placeholder/);
  });

  it('lays out the real corpus generator\'s slices', async () => {
    const { buildCorpus } = await import('../../corpus/generate.ts');
    const corpus = buildCorpus('0000000000000000000000000000000000000000');
    const text = new Map(corpus.files.map((file) => [file.path, file.content.toString('utf8')]));
    const names = runNames('4f1a9c');
    for (const slice of ['mini', 'bank', 'mid', 'full'] as const) {
      const paths = corpus.slices[slice];
      const readmes = new Map(paths.filter((path) => /(^|\/)README\.md$/.test(path)).map((path) => [path, text.get(path) ?? '']));
      const tree = buildRunTree({ slice, paths }, readmes, names);
      assert.equal(tree.paths.size, paths.filter((path) => !path.startsWith('.github/') || path === CHECK_WORKFLOW_PATH).length, slice);
      assert.equal(tree.paths.get(CHECK_WORKFLOW_PATH), CHECK_WORKFLOW_PATH);
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
    assert.ok(!files.some((file) => file.startsWith('.github/')));
    const enabled = runNames('abcdef');
    await sandbox.createTrackedBranch('mini', enabled, { checks: true });
    const enabledFiles = (await new Git(remote).text(['ls-tree', '-r', '--name-only', enabled.trackedBranch])).split('\n');
    assert.deepEqual(enabledFiles.filter((file) => file.startsWith('.github/')), [CHECK_WORKFLOW_PATH]);
    await sandbox.deleteRunRefs(enabled.runId, [`refs/heads/${enabled.trackedBranch}`]);
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

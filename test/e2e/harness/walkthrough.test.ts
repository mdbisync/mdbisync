import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import type { TestConfig } from './config.ts';
import { EnvBlockedError } from './results.ts';
import { readTemplate, WORKFLOW_FILES } from './workflow-files.ts';
import { requireWalkthroughIsolation, walkthrough, walkthroughRef } from './walkthrough.ts';

const ref = 't/abcdef/main';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config: TestConfig = {
  sandboxUrl: 'https://github.com/example/sandbox', gitUrl: 'https://github.com/example/sandbox', owner: 'example', repo: 'sandbox',
  githubApp: { clientId: 'example-client', privateKey }, githubAppMissing: [], linearApps: [], editors: { 'editor-a': '', 'editor-b': '' }, missing: [],
};
const run = (id = 2, status = 'completed', conclusion = 'success') => ({ id, status, conclusion, head_branch: ref, event: 'workflow_dispatch', created_at: new Date().toISOString(), path: '.github/workflows/mdbisync-initial-sync.yml' });

// Minimal stored zip, so the tests exercise the actual report download path.
function summaryZip(text: string): Buffer {
  return logZip({ 'summary.md': text });
}

function logZip(files: Record<string, string>): Buffer {
  // Stored entries: local records first, then the central directory with offsets.
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = Buffer.from(path); const data = Buffer.from(text);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(central, name); offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'walkthrough-'));
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  for (const file of Object.values(WORKFLOW_FILES)) writeFileSync(join(dir, '.github/workflows', file), readTemplate(file));
  return dir;
}

it('guards refs and arguments before authenticating, and names the missing sandbox configuration', async () => {
  for (const invalid of ['main', 'refs/heads/t/abcdef/main', 't/123456/main', 't/abcdef/../main', 't/abcdef/schedule', 't/abcdef/sync']) assert.throws(() => walkthroughRef('abcdef', invalid));
  assert.equal(walkthroughRef('abcdef', ref), ref);
  let connected = false;
  const options = { config, connect: async () => { connected = true; throw new Error('unexpected'); } };
  for (const args of [
    ['list', '--ref', 'main'], ['dispatch', '--workflow', '../settings'],
    ['dispatch', '--workflow', WORKFLOW_FILES['initial-sync'], '--input', 'tracked-branch=main'],
    ['dispatch', '--workflow', WORKFLOW_FILES['initial-sync'], '--input', 'direction=other'],
    ['cancel', '--run-number', '../1'], ['list', 'extra'],
    ['wait', '--run-number', '0x10'], ['list', '--workflow', WORKFLOW_FILES.sync], ['dispatch', '--run-number', '2'],
  ]) await assert.rejects(walkthrough([...args, '--run', 'abcdef'], options));
  await assert.rejects(walkthrough(['list', '--run', 'abcdef'], { ...options, config: { ...config, sandboxUrl: '' } }), (error: unknown) => error instanceof EnvBlockedError && /MDBISYNC_TEST_SANDBOX_URL/.test(error.message));
  assert.equal(connected, false);
});

it('prepares copied workflows locally and pushes only a committed isolated branch', async () => {
  const dir = fixture();
  const output: string[] = []; const pushes: unknown[] = [];
  const options = { config, write: (text: string) => { output.push(text); }, connect: async () => ({ rest: {} as never, git: {} as never, safe: (text: string) => text, push: async (...args: unknown[]) => { pushes.push(args); } }) };
  try {
    assert.throws(() => requireWalkthroughIsolation(readTemplate(WORKFLOW_FILES.sync), 'abcdef'));
    await walkthrough(['prepare', '--run', 'abcdef', '--dir', dir], options);
    const first = Object.values(WORKFLOW_FILES).map((file) => readFileSync(join(dir, '.github/workflows', file), 'utf8'));
    await walkthrough(['prepare', '--run', 'abcdef', '--dir', dir], options);
    assert.deepEqual(Object.values(WORKFLOW_FILES).map((file) => readFileSync(join(dir, '.github/workflows', file), 'utf8')), first);
    for (const file of [WORKFLOW_FILES.sync, WORKFLOW_FILES['initial-sync']]) {
      const text = readFileSync(join(dir, '.github/workflows', file), 'utf8');
      requireWalkthroughIsolation(text, 'abcdef');
      assert.match(text, /summary|mdbisync-report/);
      assert.match(text, /upload-artifact@/);
      assert.throws(() => requireWalkthroughIsolation(text.replace('mdbisync-abcdef', 'mdbisync-shared'), 'abcdef', file));
      assert.throws(() => requireWalkthroughIsolation(text.replace('mdbisync-sandbox', 'ubuntu-latest'), 'abcdef', file));
      assert.throws(() => requireWalkthroughIsolation(text.replace('- t/abcdef/main', '- main'), 'abcdef', file));
    }
    requireWalkthroughIsolation(readFileSync(join(dir, '.github/workflows', WORKFLOW_FILES['pre-commit']), 'utf8'), 'abcdef', WORKFLOW_FILES['pre-commit']);
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
    git('init', '--initial-branch', ref); git('add', '.github');
    git('-c', 'user.name=Test Editor', '-c', 'user.email=editor@example.com', 'commit', '-m', 'Prepare workflows');
    // The transfer reads the branch commit, even if the working copy changes.
    writeFileSync(join(dir, '.github/workflows', WORKFLOW_FILES.sync), 'uncommitted');
    assert.equal(await walkthrough(['push', '--run', 'abcdef', '--dir', dir], options), 0);
    assert.deepEqual(pushes, [[dir, ref]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('dispatches on the run ref, polls a new run and prints its summary without the App token', async () => {
  const dir = fixture();
  try {
    await walkthrough(['prepare', '--run', 'abcdef', '--dir', dir], { write: () => {} });
    const token = 'installation-test-secret';
    const sent: Array<{ path: string; method: string; body: unknown }> = []; let polls = 0; let registrations = 0; let dispatched = false;
    const output: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      sent.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path.endsWith('/installation')) return Response.json({ id: 1, app_slug: 'example' });
      if (path.endsWith('/access_tokens')) return Response.json({ token });
      assert.equal((init?.headers as Record<string, string>)['authorization'], `Bearer ${token}`);
      if (path.includes('/contents/')) {
        const text = readFileSync(join(dir, '.github/workflows', path.split('/').at(-1)!), 'utf8');
        return Response.json({ encoding: 'base64', content: Buffer.from(text).toString('base64') });
      }
      if (path.endsWith('/workflows')) return Response.json({ workflows: ++registrations === 1 ? [] : [{ id: 7, path: '.github/workflows/mdbisync-initial-sync.yml' }] });
      if (path.endsWith('/dispatches')) { dispatched = true; return new Response(null, { status: 204 }); }
      if (path.endsWith('/runs')) {
        polls += 1;
        return Response.json({ workflow_runs: !dispatched ? [run(1)] : [run(2, polls < 3 ? 'in_progress' : 'completed'), run(1)] });
      }
      if (path.endsWith('/artifacts')) return Response.json({ artifacts: [{ id: 3, name: 'mdbisync-report', expired: false }] });
      if (path.endsWith('/zip')) return new Response(summaryZip(`# Dry run\nCreate docs/notes.md\n${token}`));
      throw new Error(`unexpected path ${path}`);
    }) as typeof fetch;
    assert.equal(await walkthrough(['dispatch', '--run', 'abcdef', '--workflow', WORKFLOW_FILES['initial-sync'], '--input', 'direction=git-to-linear', '--input', 'confirm=false'], { config, fetch: fetchImpl, write: (text) => { output.push(text); }, pollMs: 1, timeoutMs: 1000 }), 0);
    assert.deepEqual(sent.find((item) => item.path.endsWith('/dispatches'))?.body, { ref, inputs: { direction: 'git-to-linear', confirm: 'false' } });
    assert.ok(sent.some((item) => item.path.endsWith('/workflows/7/dispatches')));
    assert.match(output.join(''), /Create docs\/notes.md/);
    assert.match(output.join(''), /"id":2/);
    assert.ok(!output.join('').includes(token));
    assert.ok(polls >= 3);
    assert.equal(registrations, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('lists and cancels only the selected run branch and workflows; wait preserves a failed conclusion', async () => {
  const output: string[] = []; const calls: string[] = [];
  let selected = run(2, 'completed', 'failure');
  const options = { config, write: (text: string) => { output.push(text); }, connect: async () => ({ safe: (text: string) => text, push: async () => {}, git: {} as never, rest: {
    workflowRuns: async () => [run(), { ...run(3), head_branch: 'main' }, { ...run(4), path: '.github/workflows/other.yml' }],
    request: async (method: string, path: string) => { calls.push(`${method} ${path}`); return path.endsWith('/artifacts') ? { artifacts: [] } : selected; },
    runJobs: async () => [{ id: 9, name: 'sync', conclusion: 'failure', steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Sync with Linear', conclusion: 'failure' }] }],
    download: async () => logZip({ 'sync/2_Sync with Linear.txt': '\uFEFF2026-11-12T10:00:00.0000000Z ##[error]initial-sync-required: run the initial sync first\n', '0_sync.txt': '2026-11-12T10:00:00.0000000Z ##[error]initial-sync-required: run the initial sync first\n' }),
  } as never }) };
  await walkthrough(['list', '--run', 'abcdef'], options);
  assert.equal(output.length, 1);
  await walkthrough(['cancel', '--run', 'abcdef', '--run-number', '2'], options);
  assert.ok(calls.includes('POST /actions/runs/2/cancel'));
  selected = { ...selected, head_branch: 't/123456/main' };
  calls.length = 0;
  await assert.rejects(walkthrough(['cancel', '--run', 'abcdef', '--run-number', '2'], options));
  assert.deepEqual(calls, ['GET /actions/runs/2']);
  selected = run(2, 'completed', 'failure');
  assert.equal(await walkthrough(['wait', '--run', 'abcdef', '--run-number', '2'], options), 1);
  assert.match(output.join(''), /"conclusion":"failure"/);
  assert.match(output.join(''), /Summary unavailable/);
  assert.match(output.join(''), /failed step: Sync with Linear/);
  assert.equal(output.filter((line) => line.includes('Error: initial-sync-required')).length, 1);
  // A failed diagnostic read keeps the run's own result.
  output.length = 0;
  const failing = { ...options, connect: async () => ({ ...(await options.connect()), rest: { request: async (_method: string, path: string) => (path.endsWith('/artifacts') ? { artifacts: [] } : selected), runJobs: async () => { throw new Error('HTTP 403'); } } as never }) };
  assert.equal(await walkthrough(['wait', '--run', 'abcdef', '--run-number', '2'], failing), 1);
  assert.match(output.join(''), /could not be read/);
});

it('bounds wait polling and suppresses unexpected credential-bearing transport errors', async () => {
  const options = { config, write: () => {}, timeoutMs: 0, connect: async () => ({ safe: (text: string) => text, push: async () => {}, git: {} as never, rest: { request: async () => run(2, 'in_progress') } as never }) };
  await assert.rejects(walkthrough(['wait', '--run', 'abcdef', '--run-number', '2'], options), EnvBlockedError);
  await assert.rejects(walkthrough(['list', '--run', 'abcdef'], { config, connect: async () => { throw new Error('credential-value'); } }), (error: Error) => !error.message.includes('credential-value'));
});

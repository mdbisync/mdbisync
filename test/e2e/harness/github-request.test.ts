import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SandboxRest } from './github.ts';
import { githubRequestBody } from './github-request.ts';
import { blockerEvidence, workflowEvidence } from './workflows.ts';
import type { WorkflowRun } from './github.ts';

it('aborts an in-flight HTTP request when its scoped workflow deadline expires', async () => {
  const controller = new AbortController();
  let observed: AbortSignal | null | undefined;
  const fetchImpl = (async (_input, init) => {
    observed = init?.signal;
    await new Promise((_, reject) => observed!.addEventListener('abort', () => reject(observed!.reason), { once: true }));
    return Response.json({});
  }) as typeof fetch;
  const rest = new SandboxRest({ owner: 'acme', repo: 'sandbox' }, 'test-token', fetchImpl).withSignal(controller.signal);
  const pending = rest.request('GET', '/actions/runs');
  controller.abort(new Error('deadline expired'));
  await assert.rejects(pending, /deadline expired/);
  assert.equal(observed?.aborted, true);
});

it('sends only checked GitHub fields and refuses malformed data before making a request', async () => {
  const sent: RequestInit[] = [];
  const fetchImpl = (async (_url, init) => { sent.push(init!); return Response.json({ ok: true }); }) as typeof fetch;
  const rest = new SandboxRest({ owner: 'acme', repo: 'sandbox' }, 'test-token', fetchImpl);
  const body = { head: 'topic', base: 'main', title: 'Résumé 📝', body: '# Plan\nNext steps.' };
  await rest.request('POST', '/pulls', body);
  assert.deepEqual(JSON.parse(sent[0]!.body as string), body);
  for (const invalid of [{ ...body, extra: 'not allowed' }, { title: {} }, { title: 'bad\0title' }, { content: 'not base64!' }, { inputs: { value: {} } }, { state: 'unknown' }]) {
    await assert.rejects(rest.request('POST', '/pulls', invalid));
  }
  await assert.rejects(rest.request('GET', '/pulls\nforged'));
  await assert.rejects(rest.download('/artifacts\nforged'));
  for (const suffix of ['\n', '\r', '\u2028', '\u2029']) {
    await assert.rejects(rest.request('GET', `/pulls${suffix}`));
    const trailing = new SandboxRest({ owner: 'acme', repo: 'sandbox' }, `test-token${suffix}`, fetchImpl);
    await assert.rejects(trailing.request('GET', '/pulls'));
    assert.throws(() => githubRequestBody({ repositories: [`sandbox${suffix}`] }));
    assert.throws(() => githubRequestBody({ content: `YWJj${suffix}` }));
    assert.throws(() => githubRequestBody({ inputs: { [`run_id${suffix}`]: 'abc123' } }));
  }
  const invalidToken = new SandboxRest({ owner: 'acme', repo: 'sandbox' }, 'bad\r\ntoken', fetchImpl);
  await assert.rejects(invalidToken.request('GET', '/pulls'));
  await assert.rejects(invalidToken.download('/artifacts'));
  assert.equal(sent.length, 1);
});

it('preserves file upload bytes, workflow inputs and repository selection', () => {
  const body = { message: 'Update notes', content: Buffer.from('Résumé\n').toString('base64'), sha: 'revision' };
  assert.deepEqual(githubRequestBody(body), body);
  assert.deepEqual(githubRequestBody({ ref: 'main', inputs: { run_id: 'abc123' } }), { ref: 'main', inputs: { run_id: 'abc123' } });
  assert.deepEqual(githubRequestBody({ repositories: ['sandbox', '.github', '_notes', '-notes'] }), { repositories: ['sandbox', '.github', '_notes', '-notes'] });
});

it('passes only named read or write token permissions', () => {
  assert.deepEqual(githubRequestBody({ repositories: ['sandbox'], permissions: { actions: 'read' } }), { repositories: ['sandbox'], permissions: { actions: 'read' } });
  for (const permissions of [{}, { actions: 'admin' }, { 'Actions!': 'write' }, ['actions'], null]) {
    assert.throws(() => githubRequestBody({ permissions }));
  }
});

it('projects bounded workflow evidence and rejects malformed remote metadata', () => {
  const run = { id: 42, event: 'push', status: 'completed', conclusion: 'failure', created_at: '2026-01-01', extra: 'discarded' } as WorkflowRun;
  assert.equal(workflowEvidence(run).id, 42);
  assert.equal('extra' in workflowEvidence(run), false);
  assert.equal(workflowEvidence({ ...run, status: null, head_branch: null }).head_branch, null);
  assert.equal(workflowEvidence({ ...run, status: null }).status, null);
  assert.throws(() => workflowEvidence({ ...run, id: '../escape' as unknown as number }));
  assert.throws(() => workflowEvidence({ ...run, head_branch: 'x'.repeat(1025) }));
  const blocker = { runId: 42, job: 'check', step: 'setup', cause: 'missing command', logFile: 'check/1_setup.txt', reason: 'Install command' };
  assert.deepEqual(blockerEvidence(blocker), blocker);
  assert.throws(() => blockerEvidence({ ...blocker, reason: 'bad\0reason' }));
});

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SandboxRest } from './github.ts';
import { githubRequestBody } from './github-request.ts';
import { blockerEvidence, workflowEvidence } from './workflows.ts';
import type { WorkflowRun } from './github.ts';

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
  const invalidToken = new SandboxRest({ owner: 'acme', repo: 'sandbox' }, 'bad\r\ntoken', fetchImpl);
  await assert.rejects(invalidToken.request('GET', '/pulls'));
  assert.equal(sent.length, 1);
});

it('preserves file upload bytes, workflow inputs and repository selection', () => {
  const body = { message: 'Update notes', content: Buffer.from('Résumé\n').toString('base64'), sha: 'revision' };
  assert.deepEqual(githubRequestBody(body), body);
  assert.deepEqual(githubRequestBody({ ref: 'main', inputs: { run_id: 'abc123' } }), { ref: 'main', inputs: { run_id: 'abc123' } });
  assert.deepEqual(githubRequestBody({ repositories: ['sandbox'] }), { repositories: ['sandbox'] });
});

it('projects bounded workflow evidence and rejects malformed remote metadata', () => {
  const run = { id: 42, event: 'push', status: 'completed', conclusion: 'failure', created_at: '2026-01-01', extra: 'discarded' } as WorkflowRun;
  assert.equal(workflowEvidence(run).id, 42);
  assert.equal('extra' in workflowEvidence(run), false);
  assert.throws(() => workflowEvidence({ ...run, id: '../escape' as unknown as number }));
  assert.throws(() => workflowEvidence({ ...run, head_branch: 'x'.repeat(1025) }));
  const blocker = { runId: 42, job: 'check', step: 'setup', cause: 'missing command', logFile: 'check/1_setup.txt', reason: 'Install command' };
  assert.deepEqual(blockerEvidence(blocker), blocker);
  assert.throws(() => blockerEvidence({ ...blocker, reason: 'bad\0reason' }));
});

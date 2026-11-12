import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import type { Sides } from './checks.ts';
import type { RunContext } from './context.ts';
import { startFaultProxy, type ProxyRequestRecord } from './fault-proxy.ts';
import { renderRunMarkdown, type HarnessReport } from './report.ts';
import { answerSizes } from './request-accounting.ts';
import type { ScenarioResult } from './results.ts';
import { conflictMarks } from './subjects.ts';

describe('answer sizes', () => {
  it('the proxy measures each forwarded answer: decoded bytes and time to its end', async () => {
    const body = JSON.stringify({ data: { documents: { nodes: [{ content: 'x'.repeat(5000) }] } } });
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => setTimeout(() => response.writeHead(200, { 'content-type': 'application/json' }).end(body), 30));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const proxy = await startFaultProxy(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    try {
      const response = await fetch(`${proxy.url}/graphql`, { method: 'POST', body: JSON.stringify({ query: 'query ListDocuments { documents { nodes { content } } }', operationName: 'ListDocuments' }) });
      assert.equal(await response.text(), body);
      proxy.setFaults([{ kind: 'http', status: 500, requestNumber: 1, retryAfterSeconds: null, times: 1 }]);
      await (await fetch(`${proxy.url}/graphql`, { method: 'POST', body: JSON.stringify({ query: 'query GetDocuments { a }', operationName: 'GetDocuments' }) })).text();
      const [forwarded, injected] = proxy.requests;
      assert.equal(forwarded?.responseBytes, Buffer.byteLength(body));
      assert.ok((forwarded?.durationMs ?? 0) >= 25, `measured ${forwarded?.durationMs} ms`);
      // An answer the proxy made up says nothing about Linear's pages.
      assert.equal(injected?.injected, true);
      assert.equal(injected?.responseBytes, undefined);
    } finally {
      await proxy.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('keep per operation the largest answer, its duration and the slowest one', () => {
    const record = (operation: string, responseBytes: number | undefined, durationMs: number | undefined): ProxyRequestRecord => ({
      n: 0, operation, kind: 'query', status: 200, injected: false, at: 0,
      ...(responseBytes === undefined ? {} : { responseBytes }), ...(durationMs === undefined ? {} : { durationMs }),
    });
    assert.deepEqual(answerSizes([
      record('ListDocuments', 1000, 900), record('ListDocuments', 5000, 400), record('ListDocuments', 2000, 1200),
      record('GetDocuments', 300, 50), record('UpdateDocument', undefined, undefined),
    ]), {
      ListDocuments: { count: 3, maxBytes: 5000, maxBytesDurationMs: 400, maxDurationMs: 1200 },
      GetDocuments: { count: 1, maxBytes: 300, maxBytesDurationMs: 50, maxDurationMs: 50 },
    });
  });
});

describe('conflict marks', () => {
  it('list mapped documents that carry the conflict mark, with the saved icon and their comment count', async () => {
    const documents = new Map([
      ['d1', { id: 'd1', icon: 'Alert', color: '#F2994A' }],
      ['d2', { id: 'd2', icon: 'Book', color: '#5E6AD2' }],
      ['d3', { id: 'd3', icon: 'Alert', color: '#5E6AD2' }],
    ]);
    const ids = new Map([
      ['conflict-markers/sync-markers-code.md', { id: 'd1', saved: { icon: null, color: null } }],
      ['conflict-markers/equals-setext-lookalike.md', { id: 'd2' }],
      ['notes/own-alert-icon.md', { id: 'd3' }],
    ]);
    const asked: string[] = [];
    const ctx = { live: { app: { request: async (_name: string, _kind: string, _query: string, variables: { id: string }) => {
      asked.push(variables.id);
      return { document: { comments: { nodes: [{ body: 'one', createdAt: '2026-11-12T00:00:00Z' }] } } };
    } } } } as unknown as RunContext;
    const result = await conflictMarks(ctx, { ids, documents } as unknown as Sides);
    assert.deepEqual(result, {
      mapped: 3,
      marked: [{ path: 'conflict-markers/sync-markers-code.md', icon: 'Alert', color: 'orange', saved: { icon: null, color: null }, comments: 1 }],
    });
    // Comments are read only for the marked document.
    assert.deepEqual(asked, ['d1']);
  });
});

describe('the run report', () => {
  const result = (extra: Partial<ScenarioResult>): ScenarioResult => ({
    id: 'L1-16', level: 'L1', slice: 'full', mode: 'local', runId: '4f1a9c', result: 'pass', startedAt: '2026-11-12T00:00:00.000Z',
    durationMs: 1000, engineRequests: 3, harnessRequests: 0, harnessAppRequests: 4, budgetWaitMs: 0, checks: [], cleanup: { ok: true }, ...extra,
  });
  const report = (results: ScenarioResult[]): HarnessReport => ({ harnessRunId: 'r', startedAt: '', finishedAt: '', host: 'test', selection: {}, results });

  it('shows the largest engine answers and the conflict marks at the end', () => {
    const markdown = renderRunMarkdown(report([
      result({ answerSizes: { ListDocuments: { count: 4, maxBytes: 12_345_678, maxBytesDurationMs: 8400, maxDurationMs: 9100 } } }),
      result({ id: 'L1-15', slice: 'mid', conflictMarks: { mapped: 200, marked: [{ path: 'conflict-markers/sync-markers-code.md', icon: 'Alert', color: 'orange', saved: { icon: null, color: null }, comments: 1 }] } }),
      result({ id: 'L1-07', slice: 'mid', conflictMarks: { mapped: 40, marked: [] } }),
    ]));
    assert.match(markdown, /\| L1-16 \| ListDocuments \| 4 \| 12345678 \| 8\.4 \| 9\.1 \|/);
    assert.match(markdown, /\| L1-15 \| 200 \| conflict-markers\/sync-markers-code\.md \| Alert\/orange \| none\/none \| 1 \|/);
    assert.match(markdown, /\| L1-07 \| 40 \| none \|/);
  });

  it('adds no section without measurements', () => {
    const markdown = renderRunMarkdown(report([result({})]));
    assert.doesNotMatch(markdown, /Largest engine answers|Conflict marks/);
  });
});

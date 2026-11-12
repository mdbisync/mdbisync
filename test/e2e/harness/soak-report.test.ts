import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { EngineResult } from './engine.ts';
import type { LogEntry } from '../../../src/linear/index.ts';
import { diagnosticRequests } from './request-accounting.ts';
import { delayDistribution, observedTokens } from './soak-report.ts';

const entry = (operation: string, extra: Partial<LogEntry> = {}): LogEntry => ({
  operation, kind: 'oauth', attempt: 1, status: 200, durationMs: 1,
  startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', rateLimitHeaders: {}, ...extra,
});
const result = (requests: LogEntry[], id = 1): EngineResult => ({
  remote: { runId: id, runAttempt: 1, linearEngine: true, requests },
} as EngineResult);

it('retains schedule samples in order and calculates nearest-rank percentiles', () => {
  assert.deepEqual(delayDistribution([300, 0, 100, 200]), { samples: [300, 0, 100, 200], count: 4, p50: 100, p95: 300, p99: 300, max: 300 });
  assert.equal(delayDistribution([]).p50, null);
});

it('counts confirmed token revocation once per workflow attempt without retaining bearer tokens', () => {
  const requests = diagnosticRequests(new Map([['job', [
    entry('oauth.token'), entry('oauth.revoke', { revocationConfirmed: true }),
  ].map((item) => JSON.stringify({ ...item, accessToken: 'private-canary' })).join('\n')]]));
  assert.equal(JSON.stringify(requests).includes('private-canary'), false);
  const first = result(requests);
  assert.deepEqual(observedTokens([first, first]), { minted: 1, confirmedRevoked: 1, outstanding: 0, scope: 'observed workflow engine tokens' });
  assert.equal(observedTokens([first, { ...first, remote: { ...first.remote!, runAttempt: 2 } }]).minted, 2);
});

it('keeps missing diagnostics unknown and unconfirmed revocations outstanding', () => {
  assert.equal(observedTokens([result([])]).outstanding, null);
  assert.equal(observedTokens([]).outstanding, null);
  for (const revocationConfirmed of [false, undefined]) {
    assert.equal(observedTokens([result([entry('oauth.token'), entry('oauth.revoke', revocationConfirmed === undefined ? {} : { revocationConfirmed })])]).outstanding, 1);
  }
  assert.equal(observedTokens([result([entry('oauth.token', { status: 'network-error' })])]).outstanding, null);
  assert.equal(observedTokens([result([entry('oauth.revoke', { revocationConfirmed: true })])]).outstanding, null);
});

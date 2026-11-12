import type { EngineResult } from './engine.ts';

/** Keep the samples as well as nearest-rank percentiles; an empty series has no percentile. */
export function delayDistribution(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
  return { samples: [...samples], count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: sorted.at(-1) ?? null };
}

/** Outstanding observed engine tokens, not a workspace-wide token census. Never infer zero from missing logs. */
export function observedTokens(results: readonly EngineResult[]) {
  let minted = 0;
  let revoked = 0;
  let complete = true;
  const seen = new Set<string>();
  for (const result of results) {
    const remote = result.remote;
    if (remote === undefined || !remote.linearEngine) continue;
    const key = `${remote.runId}:${remote.runAttempt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const exchanges = remote.requests.filter((entry) => entry.operation === 'oauth.token');
    const issued = exchanges.filter((entry) => typeof entry.status === 'number' && entry.status >= 200 && entry.status < 300 && (entry.errorCodes?.length ?? 0) === 0).length;
    const confirmed = remote.requests.filter((entry) => entry.operation === 'oauth.revoke' && entry.revocationConfirmed === true).length;
    minted += issued;
    revoked += confirmed;
    if (exchanges.length === 0 || confirmed > issued || (issued === 0 && exchanges.some((entry) => entry.status === 'network-error'))) complete = false;
  }
  return { minted, confirmedRevoked: revoked, outstanding: complete && seen.size > 0 ? minted - revoked : null, scope: 'observed workflow engine tokens' };
}

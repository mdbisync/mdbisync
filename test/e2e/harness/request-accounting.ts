// Remote diagnostics complement the local proxy. Overview and per-step logs
// repeat the same events; retries and separate workflow attempts remain distinct.
import type { LogEntry } from '../../../src/linear/index.ts';
import type { RunContext } from './context.ts';

export interface RemoteRequests {
  runId: number;
  runAttempt: number;
  /** False only for the known formatting-only workflow; unknown runs stay conservative. */
  linearEngine: boolean;
  requests: LogEntry[];
}

export function diagnosticRequests(logs: ReadonlyMap<string, string>): LogEntry[] {
  const unique = new Map<string, LogEntry>();
  const withoutId = new Map<string, { entry: LogEntry; overview: number; steps: number }>();
  for (const [file, log] of logs) for (const line of log.split('\n')) {
    const start = line.indexOf('{');
    if (start < 0) continue;
    let entry: LogEntry;
    try { entry = JSON.parse(line.slice(start)) as LogEntry; } catch { continue; }
    if (entry === null || typeof entry !== 'object' ||
        !['query', 'mutation', 'oauth'].includes(entry.kind) || typeof entry.operation !== 'string' ||
        !Number.isInteger(entry.attempt) || entry.attempt < 1 || !Number.isFinite(entry.durationMs) ||
        !Number.isFinite(Date.parse(entry.startedAt)) || !Number.isFinite(Date.parse(entry.finishedAt)) ||
        !(typeof entry.status === 'number' || entry.status === 'network-error') ||
        entry.rateLimitHeaders === null || typeof entry.rateLimitHeaders !== 'object') continue;
    // Keep only the transport's safe schema, never arbitrary JSON from a log.
    const safe: LogEntry = {
      operation: entry.operation, kind: entry.kind, attempt: entry.attempt,
      status: entry.status, durationMs: entry.durationMs,
      startedAt: entry.startedAt, finishedAt: entry.finishedAt,
      rateLimitHeaders: Object.fromEntries(Object.entries(entry.rateLimitHeaders)
        .filter(([key, value]) => /^x-(?:ratelimit-[a-z0-9-]+|complexity)$/i.test(key) && typeof value === 'string')),
      ...(Array.isArray(entry.errorCodes) ? { errorCodes: entry.errorCodes.filter((code) => typeof code === 'string') } : {}),
      ...(typeof entry.requestId === 'string' ? { requestId: entry.requestId } : {}),
    };
    if (safe.requestId !== undefined) unique.set(requestKey(safe), safe);
    else {
      const key = requestKey(safe);
      const count = withoutId.get(key) ?? { entry: safe, overview: 0, steps: 0 };
      if (file.includes('/')) count.steps++;
      else count.overview++;
      withoutId.set(key, count);
    }
  }
  // Without a server id, identical concurrent attempts remain separate within
  // a step. The overview repeats those attempts; use the larger multiplicity.
  return [...unique.values(), ...[...withoutId.values()].flatMap(({ entry, overview, steps }) =>
    Array.from({ length: Math.max(overview, steps) }, () => entry))];
}

function requestKey(entry: LogEntry): string {
  return JSON.stringify([entry.kind, entry.operation, entry.attempt,
    entry.requestId ?? null, entry.startedAt, entry.finishedAt]);
}

export function remoteRequests(ctx: RunContext): Array<{ phase: 'setup' | 'scenario' | 'I6'; entry: LogEntry }> {
  const seen = new Set<string>();
  const end = Number(ctx.observations.get('scenario.runsEnd') ?? ctx.engine.results.length);
  return ctx.engine.results.flatMap((result, index) => {
    const remote = result.remote;
    if (remote === undefined) return [];
    const phase = index < ctx.engine.setupRuns ? 'setup' : index >= end ? 'I6' : 'scenario';
    const key = `${remote.runId}:${remote.runAttempt}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return remote.requests.map((entry) => ({ phase, entry }));
  });
}

export function isGraphql(entry: LogEntry): boolean {
  return entry.kind === 'query' || entry.kind === 'mutation';
}

export function isDocumentWrite(entry: { kind: string; operation: string; status: number | string; errorCodes?: string[] | undefined }): boolean {
  return entry.kind === 'mutation' && /document(Create|Update)|(Create|Update)Document/i.test(entry.operation) && entry.status === 200 && (entry.errorCodes?.length ?? 0) === 0;
}

/** Local counting stays exactly as before; remote GraphQL includes upload URL mutations. */
export function engineRequestCount(ctx: RunContext, remote = remoteRequests(ctx)): number {
  return (ctx.proxy?.requests.filter((record) => !record.injected).length ?? 0) +
    remote.filter(({ entry }) => isGraphql(entry)).length;
}

/** Disjoint phases and transport buckets; upload URL GraphQL is also identified as a subset. */
export function requestBuckets(ctx: RunContext, entries = remoteRequests(ctx)) {
  const phase = (name: 'setup' | 'scenario' | 'I6') => {
    const requests = entries.filter((item) => item.phase === name).map((item) => item.entry);
    return {
      graphql: requests.filter(isGraphql).length,
      uploadGraphql: requests.filter((entry) => isGraphql(entry) && /fileUploads?/i.test(entry.operation)).length,
      // PUTs to object storage have no transport diagnostics; never invent zero cost.
      uploadPut: 'unobserved' as const,
      oauthExchange: requests.filter((entry) => entry.kind === 'oauth' && entry.operation === 'oauth.token').length,
      oauthRevoke: requests.filter((entry) => entry.kind === 'oauth' && entry.operation === 'oauth.revoke').length,
    };
  };
  const local = ctx.proxy?.requests ?? [];
  const start = Number(ctx.observations.get('start.proxyIndex') ?? 0);
  const end = Number(ctx.observations.get('scenario.proxyEnd') ?? local.length);
  const count = (from: number, to: number) => local.slice(from, to).filter((entry) => !entry.injected).length;
  return {
    local: { setup: count(0, start), scenario: count(start, end), I6: count(end, local.length) },
    remote: { setup: phase('setup'), scenario: phase('scenario'), I6: phase('I6') },
  };
}

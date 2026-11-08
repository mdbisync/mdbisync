// Linear's rate-limit headers and the client's own budget floor.
//
// Linear sends, on every API response:
//   x-ratelimit-requests-{limit,remaining,reset}
//   x-ratelimit-complexity-{limit,remaining,reset}
//   x-complexity (the cost of this request)
// and, for endpoints with lower limits of their own, x-ratelimit-endpoint-*
// headers. Reset values are epoch milliseconds.

import type { StopReason } from './errors.ts';

export interface RateLimitSnapshot {
  requestsLimit?: number | undefined;
  requestsRemaining?: number | undefined;
  requestsReset?: number | undefined;
  complexityLimit?: number | undefined;
  complexityRemaining?: number | undefined;
  complexityReset?: number | undefined;
  /** Complexity points this request cost. */
  complexity?: number | undefined;
  endpointName?: string | undefined;
  endpointRequestsLimit?: number | undefined;
  endpointRequestsRemaining?: number | undefined;
  endpointRequestsReset?: number | undefined;
  /** Every `x-ratelimit-*` and `x-complexity` header as received, for logs. */
  headers: Record<string, string>;
}

export interface BudgetFloor {
  /** Stop when `x-ratelimit-requests-remaining` falls below this. */
  minRequestsRemaining: number;
  /** Stop when `x-ratelimit-complexity-remaining` falls below this. */
  minComplexityRemaining: number;
  /** Stop when `x-ratelimit-endpoint-requests-remaining` falls below this. */
  minEndpointRequestsRemaining: number;
}

/**
 * Defaults leave room for the other runs sharing the app's hourly budget to
 * finish their current step. The engine may raise or lower them per run.
 */
export const DEFAULT_BUDGET_FLOOR: BudgetFloor = {
  minRequestsRemaining: 100,
  minComplexityRemaining: 50_000,
  minEndpointRequestsRemaining: 5,
};

export function readRateLimitHeaders(headers: Headers): RateLimitSnapshot {
  const raw: Record<string, string> = {};
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (key.startsWith('x-ratelimit-') || key === 'x-complexity') {
      raw[key] = value;
    }
  }
  const num = (key: string): number | undefined => {
    const value = raw[key];
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    requestsLimit: num('x-ratelimit-requests-limit'),
    requestsRemaining: num('x-ratelimit-requests-remaining'),
    requestsReset: num('x-ratelimit-requests-reset'),
    complexityLimit: num('x-ratelimit-complexity-limit'),
    complexityRemaining: num('x-ratelimit-complexity-remaining'),
    complexityReset: num('x-ratelimit-complexity-reset'),
    complexity: num('x-complexity'),
    endpointName: raw['x-ratelimit-endpoint-name'],
    endpointRequestsLimit: num('x-ratelimit-endpoint-requests-limit'),
    endpointRequestsRemaining: num('x-ratelimit-endpoint-requests-remaining'),
    endpointRequestsReset: num('x-ratelimit-endpoint-requests-reset'),
    headers: raw,
  };
}

/** Returns why the budget is too low to go on, or undefined when it is fine. */
export function findLowBudget(
  operation: string,
  snapshot: RateLimitSnapshot,
  floor: BudgetFloor,
): StopReason | undefined {
  const checks: Array<[string, number | undefined, number]> = [
    ['x-ratelimit-requests-remaining', snapshot.requestsRemaining, floor.minRequestsRemaining],
    ['x-ratelimit-complexity-remaining', snapshot.complexityRemaining, floor.minComplexityRemaining],
    ['x-ratelimit-endpoint-requests-remaining', snapshot.endpointRequestsRemaining, floor.minEndpointRequestsRemaining],
  ];
  for (const [header, remaining, threshold] of checks) {
    if (remaining !== undefined && remaining < threshold) {
      return { kind: 'budget-low', operation, header, remaining, threshold };
    }
  }
  return undefined;
}

/**
 * Parses `Retry-After` as seconds or an HTTP date. Returns undefined when the
 * header is absent or unreadable.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

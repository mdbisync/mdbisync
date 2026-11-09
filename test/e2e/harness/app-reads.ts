// The harness's own requests through an OAuth app, counted per scenario.
// Scenarios on parallel workers share one app client, so its request total
// cannot be split between them; each scenario runs in its own async scope
// instead, and the client's request hook counts into the current scope.

import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<{ requests: number }>();

/** The app client's `beforeRequest` hook: counts one request, retries included, for the scenario that made it. */
export function countAppRequest(): void {
  const counter = scope.getStore();
  if (counter !== undefined) counter.requests += 1;
}

/** Runs `work` and returns its result with the app requests made inside it. */
export async function withAppRequests<T>(work: () => Promise<T>): Promise<{ result: T; requests: number }> {
  const counter = { requests: 0 };
  const result = await scope.run(counter, work);
  return { result, requests: counter.requests };
}

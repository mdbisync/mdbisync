/** Non-secret metadata shared by a run's OAuth and GraphQL requests. */
export interface AuthContext {
  grantType: 'client_credentials';
  requestedScopes: string[];
  returnedScopes: string[];
}

/** Pick the schema explicitly; callers may have extra fields at runtime. */
export function authMetadata(context: AuthContext | undefined): AuthContext | undefined {
  return context === undefined ? undefined : {
    grantType: context.grantType,
    requestedScopes: [...context.requestedScopes],
    returnedScopes: [...context.returnedScopes],
  };
}

/** UTC boundaries include reading the response body, separately for each attempt. */
export function requestTiming(started: number) {
  const finished = Date.now();
  return {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
  };
}

/** Observability must not change a request's outcome or strand a minted token. */
export function emitLog<T>(log: ((entry: T) => void) | undefined, entry: T): void {
  try {
    void Promise.resolve(log?.(entry)).catch(() => {});
  } catch {
    // A caller owns its sink's health; request completion and cleanup take priority.
  }
}

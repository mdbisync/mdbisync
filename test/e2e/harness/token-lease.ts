// A harness credential lease: refresh before expiry and share concurrent mints.
// The caller owns revocation of every successfully minted credential.
export function tokenLease<T>(initial: T, lifetimeMs: (value: T) => number, mint: () => Promise<T>, now: () => number = Date.now): () => Promise<T> {
  const expires = (value: T) => {
    const lifetime = lifetimeMs(value);
    if (!Number.isFinite(lifetime) || lifetime <= 0) throw new Error('credential lifetime is unavailable');
    return now() + lifetime * 0.75;
  };
  let until = expires(initial);
  let value = initial;
  let pending: Promise<T> | undefined;
  return async () => {
    if (now() < until) return value;
    if (pending === undefined) pending = Promise.resolve().then(mint).then((next) => {
      until = expires(next);
      value = next;
      return next;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}

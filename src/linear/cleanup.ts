import { withRunToken, type AppCredentials, type TokenLifecycle, type TokenOptions } from './token.ts';

/**
 * Linear replaces the app's existing tokens when the requested scopes change.
 * Only a caller holding exclusive use of this app in this workspace may do
 * this: a repository concurrency group is sufficient only for a dedicated app.
 * https://linear.app/developers/oauth-2-0-authentication
 */
export async function cleanupAppTokens(
  credentials: Pick<AppCredentials, 'clientId' | 'clientSecret'>,
  options: TokenOptions & { exclusive: boolean; onRevokeError: (error: unknown) => void; lifecycle?: TokenLifecycle },
): Promise<void> {
  if (!options.exclusive) throw new Error('token cleanup requires exclusive use of the Linear app');
  const reset = (scopes: string[]) => withRunToken({ ...credentials, scopes }, options, async () => {});
  try {
    await reset(['read']);
  } finally {
    // Restore the scopes even if revocation or the first response failed.
    // This also clears a read-only token whose mint response was lost.
    await reset(['read', 'write']);
  }
}

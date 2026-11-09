// The GitHub App a deployer creates for the sync: exactly the permissions
// the setup check probes, nothing more. Two ways to create it come from the
// same list: the App manifest (`docs/github-app-manifest.json`, for
// GitHub's create-App-from-manifest form) and a link with the same settings
// as URL parameters, which a page or a terminal can show as a plain link.

export const PROJECT_URL = 'https://github.com/mdbisync/mdbisync';

/** The repository permissions the App requests; GitHub adds metadata read on its own. */
export const APP_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  workflows: 'write',
  checks: 'read',
  statuses: 'read',
} as const satisfies Record<string, 'read' | 'write'>;

export const APP_DESCRIPTION = 'Two-way sync between Linear documents and Markdown in this repository.';

/**
 * The manifest GitHub's create-App-from-manifest flow takes. No webhook,
 * private, no events. No name: App names are unique across GitHub, so the
 * person creating it picks one.
 */
export function appManifest(): Record<string, unknown> {
  return {
    description: APP_DESCRIPTION,
    url: PROJECT_URL,
    // GitHub requires a webhook URL even when the webhook is off.
    hook_attributes: { url: PROJECT_URL, active: false },
    public: false,
    default_permissions: { ...APP_PERMISSIONS },
    default_events: [],
  };
}

/**
 * The link that opens GitHub's new-App form already filled in. Without an
 * organization it creates the App under the person's own account. The
 * person types the App's name, as with the manifest.
 */
export function appCreationUrl(organization?: string): string {
  const base = organization === undefined
    ? 'https://github.com/settings/apps/new'
    : `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`;
  const params = new URLSearchParams({
    description: APP_DESCRIPTION,
    url: PROJECT_URL,
    public: 'false',
    webhook_active: 'false',
    ...APP_PERMISSIONS,
  });
  return `${base}?${params.toString()}`;
}

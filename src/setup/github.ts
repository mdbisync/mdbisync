// Checks the GitHub token's rights without writing anything. An installation
// token does not list its own permissions, so each permission is probed with
// a request that needs it: GitHub answers 403 without the permission, and
// with it either serves a read or rejects a write's empty body with 422
// before anything is created. The repository's merge settings are read the
// same way (they are visible to a token with write access).

import { type CheckResult, failed, notChecked, passed } from './report.ts';

export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';

export interface GitHubTarget {
  /** `owner/name`. */
  repository: string;
  token: string;
  /** A commit of the repository, for the checks and statuses probes. */
  commit: string;
  apiUrl?: string | undefined;
  fetch?: typeof fetch;
}

interface Probe {
  permission: string;
  method: 'GET' | 'POST' | 'PUT';
  path: (commit: string) => string;
  body?: Record<string, unknown>;
  /** A permission without which this probe is refused anyway, so its answer says nothing. */
  requires?: string;
}

/** The permissions the sync needs, each with its probe. */
export const PERMISSION_PROBES: readonly Probe[] = [
  { permission: 'contents:write', method: 'POST', path: () => '/git/blobs', body: {} },
  { permission: 'pull_requests:write', method: 'POST', path: () => '/pulls', body: {} },
  // A content update without `content` is rejected before the path is looked at.
  {
    permission: 'workflows:write',
    method: 'PUT',
    path: () => '/contents/.github/workflows/setup-check.yml',
    body: { message: 'setup check' },
    requires: 'contents:write',
  },
  { permission: 'checks:read', method: 'GET', path: (commit) => `/commits/${commit}/check-runs?per_page=1` },
  { permission: 'statuses:read', method: 'GET', path: (commit) => `/commits/${commit}/statuses?per_page=1` },
];

export interface GitHubCheck {
  access: CheckResult;
  mergeCommits: CheckResult;
}

/** Probes the token's permissions and the repository's merge setting. At most six requests, no writes. */
export async function checkGitHub(target: GitHubTarget): Promise<GitHubCheck> {
  const request = requester(target);
  const repository = await request('GET', '');
  if (repository.status === 401 || repository.status === 403 || repository.status === 404) {
    const why = repository.status === 401 ? 'was refused' : 'cannot see the repository';
    const access = failed('github-access', 'github-credential-failed', `the GitHub token ${why} (HTTP ${repository.status})`);
    return { access, mergeCommits: notChecked('merge-commits', 'needs a working GitHub token') };
  }
  ensureAnswered(repository.status, 'reading the repository');

  const missing: string[] = [];
  const unknown: string[] = [];
  for (const probe of PERMISSION_PROBES) {
    if (probe.requires !== undefined && missing.includes(probe.requires)) {
      unknown.push(probe.permission);
      continue;
    }
    const { status } = await request(probe.method, probe.path(target.commit), probe.body);
    if (status === 403) missing.push(probe.permission);
    else if (!(status >= 200 && status < 300) && status !== 422) {
      throw new Error(`GitHub answered HTTP ${status} while checking ${probe.permission}`);
    }
  }
  const access = missing.length === 0
    ? passed('github-access', `GitHub token has ${PERMISSION_PROBES.map((probe) => probe.permission).join(', ')}`)
    : failed(
        'github-access',
        'missing-permission',
        `the GitHub token lacks ${missing.join(', ')}${unknown.length > 0 ? ` (${unknown.join(', ')} not checked without it)` : ''}`,
      );

  const allow = (repository.json as { allow_merge_commit?: unknown } | null)?.allow_merge_commit;
  const mergeCommits = typeof allow !== 'boolean'
    ? (missing.includes('contents:write')
        ? notChecked('merge-commits', 'needs contents:write to read the merge setting')
        : failed('merge-commits', 'merge-commits-required', 'GitHub did not show whether merge commits are allowed'))
    : allow
      ? passed('merge-commits', 'merge commits are allowed')
      : failed('merge-commits', 'merge-commits-required', 'merge commits are not allowed in the repository settings');
  return { access, mergeCommits };
}

function requester(target: GitHubTarget) {
  const base = `${(target.apiUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/+$/, '')}/repos/${target.repository}`;
  const fetchImpl = target.fetch ?? fetch;
  return async (method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; json: unknown }> => {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${target.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // A body that is not JSON carries nothing the check needs.
    }
    return { status: response.status, json };
  };
}

function ensureAnswered(status: number, what: string): void {
  if (status < 200 || status >= 300) throw new Error(`GitHub answered HTTP ${status} while ${what}`);
}

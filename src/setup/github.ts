// Checks the GitHub token's rights without writing anything. An installation
// token does not list its own permissions, so each permission is probed with
// a request that needs it: GitHub answers 403 without the permission, and
// with it either serves a read or rejects a write's empty body with 422
// before anything is created. The repository's merge settings are read the
// same way (they are visible to a token with write access). The App's bot
// account, which the sync's commits name as their author, is read by the
// App's slug. The rules on the sync branches are read too (any token with
// metadata access can): whether creating, updating and deleting them is
// restricted, as a ruleset that keeps them to the App does.

import { type CommitIdentity, NEUTRAL_IDENTITY } from '../state/index.ts';
import { type CheckResult, failed, notChecked, passed, warning } from './report.ts';
import { message } from '../messages.ts';

export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';

export interface GitHubTarget {
  /** `owner/name`. */
  repository: string;
  token: string;
  /** A commit of the repository, for the checks and statuses probes. */
  commit: string;
  apiUrl?: string | undefined;
  /** The slug of the App whose installation token `token` is. */
  appSlug?: string | undefined;
  /** The sync branches whose rules are read: the sync branch and its suspended branch. */
  syncBranches: readonly string[];
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
  // GitHub checks the workflows permission for this path first (403), and only
  // then rejects the update for its missing `content` (422); measured with
  // App tokens with and without the permission.
  {
    permission: 'workflows:write',
    method: 'PUT',
    path: () => '/contents/.github/workflows/setup-check.yml',
    body: { message: 'setup check' },
    requires: 'contents:write',
  },
  { permission: 'checks:read', method: 'GET', path: (commit) => `/commits/${commit}/check-runs?per_page=1` },
  { permission: 'statuses:read', method: 'GET', path: (commit) => `/commits/${commit}/statuses?per_page=1` },
  { permission: 'actions:read', method: 'GET', path: () => '/actions/runs?per_page=1' },
];

export interface GitHubCheck {
  access: CheckResult;
  app: CheckResult;
  mergeCommits: CheckResult;
  /** Whether the sync branches are kept to the App: a warning at most. */
  syncBranchRules: CheckResult;
  /** Who the sync's commits are by: the App's bot account; absent without an App slug or when it was not found. */
  identity?: CommitIdentity;
}

/**
 * Probes the token's permissions and the repository's merge setting, reads
 * the App's bot account and the rules on each sync branch. At most ten
 * requests with the two sync branches, no writes.
 */
export async function checkGitHub(target: GitHubTarget): Promise<GitHubCheck> {
  const request = requester(target);
  const repository = await request('GET', '');
  if (repository.status === 403 && isRateLimited(repository)) {
    throw new Error(message('setup.github-rate-limited'));
  }
  if (repository.status === 401 || repository.status === 403 || repository.status === 404) {
    const why = repository.status === 401 ? message('setup.github-refused', { status: repository.status }) : message('setup.github-cannot-see', { status: repository.status });
    const access = failed('github-access', 'github-credential-failed', why);
    const needsToken = 'needs a working GitHub token';
    return { access, app: notChecked('github-app', needsToken), mergeCommits: notChecked('merge-commits', needsToken), syncBranchRules: notChecked('sync-branch-rules', needsToken) };
  }
  ensureAnswered(repository.status, message('setup.github-reading-repository'));

  const missing: string[] = [];
  const unknown: string[] = [];
  for (const probe of PERMISSION_PROBES) {
    if (probe.requires !== undefined && missing.includes(probe.requires)) {
      unknown.push(probe.permission);
      continue;
    }
    const answer = await request(probe.method, probe.path(target.commit), probe.body);
    const { status } = answer;
    if (status === 403 && isRateLimited(answer)) {
      throw new Error(message('setup.github-rate-limited-permission', { permission: probe.permission }));
    }
    if (status === 403) missing.push(probe.permission);
    else if (!(status >= 200 && status < 300) && status !== 422) {
      throw new Error(message('setup.github-answered-permission', { status, permission: probe.permission }));
    }
  }
  const access = missing.length === 0
    ? passed('github-access', `GitHub token has ${PERMISSION_PROBES.map((probe) => probe.permission).join(', ')}`)
    : failed(
        'github-access',
        'missing-permission',
        message('setup.github-lacks', { permissions: missing.join(', '), unchecked: unknown.length > 0 ? message('setup.github-lacks-unchecked', { permissions: unknown.join(', ') }) : '' }),
      );

  const allow = (repository.json as { allow_merge_commit?: unknown } | null)?.allow_merge_commit;
  const mergeCommits = typeof allow !== 'boolean'
    ? (missing.includes('contents:write')
        ? notChecked('merge-commits', 'needs contents:write to read the merge setting')
        : failed('merge-commits', 'merge-commits-required', message('setup.merge-commits-unknown')))
    : allow
      ? passed('merge-commits', 'merge commits are allowed')
      : failed('merge-commits', 'merge-commits-required', message('setup.merge-commits-off'));
  return { access, mergeCommits, ...(await checkApp(target)), syncBranchRules: await checkSyncBranchRules(target) };
}

/** The rules that keep a branch to those who may bypass them, in the order the report names them. */
const BRANCH_RULES = [
  { type: 'creation', words: 'creations' },
  { type: 'deletion', words: 'deletions' },
  { type: 'update', words: 'updates' },
] as const;

/**
 * Reads the rules GitHub applies to each sync branch (active rulesets only,
 * from the repository and its organization; the branch need not exist).
 * Anyone who can push to a sync branch can add a document edit to the sync
 * pull request, which the sync merges without review. A branch whose
 * creations or deletions are not restricted is a warning; updates are named
 * on their own, since the `pre-commit` workflow's fixes need them open.
 * Classic branch protection is not among these rules, and the rules' bypass
 * list is not visible to the App, so the check cannot tell whether the App
 * is on it.
 */
async function checkSyncBranchRules(target: GitHubTarget): Promise<CheckResult> {
  const request = requester(target);
  const rulesOf = new Map<string, Set<unknown>>();
  for (const branch of target.syncBranches) {
    // A page holds up to 100 rules; a branch with more would need several rulesets of every kind.
    const answer = await request('GET', `/rules/branches/${branch.split('/').map(encodeURIComponent).join('/')}?per_page=100`);
    if (answer.status === 429 || (answer.status === 403 && isRateLimited(answer))) {
      throw new Error(message('setup.github-rate-limited-rules', { status: answer.status, branch }));
    }
    if (answer.status < 200 || answer.status >= 300 || !Array.isArray(answer.json)) {
      return warning('sync-branch-rules', message('setup.sync-branch-rules-unread', { status: answer.status, branch }));
    }
    rulesOf.set(branch, new Set((answer.json as Array<{ type?: unknown } | null>).map((rule) => rule?.type)));
  }
  const openOn = (type: string) => target.syncBranches.filter((branch) => !rulesOf.get(branch)?.has(type));
  const rules = BRANCH_RULES.map((rule) => {
    const open = openOn(rule.type);
    return open.length === 0
      ? message('setup.sync-branch-rule-restricted', { rule: rule.words })
      : message('setup.sync-branch-rule-open', { rule: rule.words, branches: open.join(' and ') });
  }).join('; ');
  const branches = target.syncBranches.join(' and ');
  return openOn('creation').length === 0 && openOn('deletion').length === 0
    ? passed('sync-branch-rules', message('setup.sync-branch-rules', { branches, rules }))
    : warning('sync-branch-rules', message('setup.sync-branch-rules-open', { branches, rules }));
}

/**
 * Reads the bot account GitHub keeps for the App (`<slug>[bot]`): its login
 * and id give the commit identity GitHub links to the App,
 * `<slug>[bot] <<id>+<slug>[bot]@users.noreply.github.com>`. An
 * installation token cannot read its own App, so the slug comes from the
 * step that minted the token.
 */
async function checkApp(target: GitHubTarget): Promise<{ app: CheckResult; identity?: CommitIdentity }> {
  if (target.appSlug === undefined) {
    return { app: passed('github-app', `no App slug given: commits name ${NEUTRAL_IDENTITY.name} <${NEUTRAL_IDENTITY.email}>`) };
  }
  const login = `${target.appSlug}[bot]`;
  const answer = await requester(target, '')('GET', `/users/${encodeURIComponent(login)}`);
  if (answer.status === 403 && isRateLimited(answer)) throw new Error(message('setup.github-rate-limited-app'));
  const notFound = failed('github-app', 'github-app-not-found', message('setup.github-app-not-found', { login }));
  if (answer.status === 404) return { app: notFound };
  ensureAnswered(answer.status, message('setup.github-reading-app'));
  const account = answer.json as { login?: unknown; id?: unknown; type?: unknown } | null;
  // A user may not take a login ending in `[bot]`, but the answer is checked all the same.
  // Logins are compared without case, as GitHub does; the commits use GitHub's spelling.
  if (typeof account?.login !== 'string' || account.login.toLowerCase() !== login.toLowerCase() || account.type !== 'Bot'
    || typeof account.id !== 'number' || !Number.isSafeInteger(account.id) || account.id <= 0) return { app: notFound };
  const identity: CommitIdentity = { name: account.login, email: `${account.id}+${account.login}@users.noreply.github.com` };
  return { app: passed('github-app', `commits name the App ${account.login}`), identity };
}

/** Requests to the API under `prefix`: the repository's paths by default. */
function requester(target: GitHubTarget, prefix = `/repos/${target.repository}`) {
  const base = `${(target.apiUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/+$/, '')}${prefix}`;
  const fetchImpl = target.fetch ?? fetch;
  return async (method: string, path: string, body?: Record<string, unknown>): Promise<Answer> => {
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
    return { status: response.status, headers: response.headers, json };
  };
}

interface Answer {
  status: number;
  headers: Headers;
  json: unknown;
}

/**
 * GitHub answers a primary or secondary rate limit with 403 too; it is a
 * wait, not a missing permission.
 */
function isRateLimited(answer: Answer): boolean {
  const message = (answer.json as { message?: unknown } | null)?.message;
  return (
    answer.headers.has('retry-after') ||
    answer.headers.get('x-ratelimit-remaining') === '0' ||
    (typeof message === 'string' && /rate limit/i.test(message))
  );
}

function ensureAnswered(status: number, what: string): void {
  if (status < 200 || status >= 300) throw new Error(message('github.answered', { status, action: what }));
}

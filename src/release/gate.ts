import { appendFile } from 'node:fs/promises';
import { validateSha } from './package.ts';

// The security gate a final release must pass before it is built. It reads the
// repository through the GitHub API and returns every reason to refuse, so a
// refused run names all of them at once. Pre-releases do not run it.

export const GATE_STATUS = 'security-gate';
const BLOCKING_SEVERITIES = ['medium', 'high', 'critical'];

export interface GateOptions {
  repository: string;
  sourceSha: string;
  token: string;
  // The workflow token cannot read secret scanning alerts; a separate read-only token can.
  secretScanningToken?: string | undefined;
  apiUrl?: string | undefined;
}

class ReadError extends Error {}

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

function nextPage(link: string | null): string | undefined {
  for (const part of (link ?? '').split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return undefined;
}

function client(apiUrl: string, defaultToken: string) {
  const origin = new URL(apiUrl).origin;
  const base = apiUrl.replace(/\/+$/, '');

  async function request(url: string, what: string, token: string): Promise<Response> {
    // A token is only ever sent to the API it was given for, even when a page link points elsewhere.
    if (URL.parse(url)?.origin !== origin) throw new ReadError(`Cannot read ${what}: the API answered with a link outside ${origin}`);
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'mdbisync-release-gate',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
    });
    if (!response.ok) {
      const message = record(await response.json().catch(() => ({}))).message;
      throw new ReadError(`Cannot read ${what}: HTTP ${response.status}${typeof message === 'string' ? ` ${message}` : ''}`);
    }
    return response;
  }

  return {
    async get(path: string, what: string, token = defaultToken): Promise<unknown> {
      return (await request(`${base}${path}`, what, token)).json();
    },
    // Every page of a list, so a blocking item on a later page is never missed.
    async list(path: string, what: string, token = defaultToken): Promise<Json[]> {
      const items: Json[] = [];
      for (let url: string | undefined = `${base}${path}`; url !== undefined;) {
        const response = await request(url, what, token);
        const page: unknown = await response.json();
        if (!Array.isArray(page)) throw new ReadError(`Cannot read ${what}: the API did not return a list`);
        items.push(...page.map(record));
        url = nextPage(response.headers.get('link'));
      }
      return items;
    },
  };
}

type Client = ReturnType<typeof client>;

async function gateStatus(api: Client, repo: string, sha: string): Promise<string | undefined> {
  // Statuses are listed newest first; the first one of the context is its current state.
  const statuses = await api.list(`/repos/${repo}/commits/${sha}/statuses?per_page=100`, 'commit statuses');
  const latest = statuses.find((status) => status.context === GATE_STATUS);
  if (latest === undefined) return `${GATE_STATUS} status is missing on ${sha}`;
  if (latest.state === 'success') return undefined;
  const description = typeof latest.description === 'string' && latest.description !== '' ? `: ${latest.description}` : '';
  return `${GATE_STATUS} status is ${String(latest.state)} on ${sha}${description}`;
}

async function codeScanningAlerts(api: Client, repo: string): Promise<string | undefined> {
  const alerts = await api.list(`/repos/${repo}/code-scanning/alerts?state=open&ref=refs/heads/main&per_page=100`, 'code scanning alerts');
  // A security alert of medium or higher blocks, and so does any alert of severity error.
  const blocking = alerts.filter((alert) => {
    const rule = record(alert.rule);
    return BLOCKING_SEVERITIES.includes(String(rule.security_severity_level)) || rule.severity === 'error';
  });
  if (blocking.length === 0) return undefined;
  const numbers = blocking.map((alert) => `#${String(alert.number)}`).join(', ');
  return `${blocking.length} open code scanning alert(s) of medium or higher on main: ${numbers}`;
}

async function secretScanningAlerts(api: Client, repo: string, token: string | undefined): Promise<string | undefined> {
  if (!token) return 'secret scanning alerts were not read: no token with Secret scanning alerts read access was given';
  const alerts = await api.list(`/repos/${repo}/secret-scanning/alerts?state=open&per_page=100`, 'secret scanning alerts', token);
  if (alerts.length === 0) return undefined;
  return `${alerts.length} open secret scanning alert(s): ${alerts.map((alert) => `#${String(alert.number)}`).join(', ')}`;
}

async function dependabotAlerts(api: Client, repo: string): Promise<string | undefined> {
  const alerts = await api.list(`/repos/${repo}/dependabot/alerts?state=open&severity=${BLOCKING_SEVERITIES.join(',')}&per_page=100`, 'Dependabot alerts');
  const blocking = alerts.filter((alert) => BLOCKING_SEVERITIES.includes(String(record(alert.security_advisory).severity)));
  if (blocking.length === 0) return undefined;
  return `${blocking.length} open Dependabot alert(s) of medium or higher: ${blocking.map((alert) => `#${String(alert.number)}`).join(', ')}`;
}

async function codeqlCoverage(api: Client, repo: string, sha: string): Promise<string | undefined> {
  // Analyses are listed newest first; the newest of each category must include the source commit.
  const analyses = await api.get(`/repos/${repo}/code-scanning/analyses?ref=refs/heads/main&tool_name=CodeQL&per_page=100`, 'CodeQL analyses');
  if (!Array.isArray(analyses) || analyses.length === 0) return 'no CodeQL analysis on main';
  const latest = new Map<string, string>();
  for (const analysis of analyses.map(record)) {
    const category = String(analysis.category ?? '');
    if (!latest.has(category) && typeof analysis.commit_sha === 'string') latest.set(category, analysis.commit_sha);
  }
  if (latest.size === 0) return 'no CodeQL analysis on main';
  const stale: string[] = [];
  for (const [category, analyzed] of latest) {
    if (analyzed === sha) continue;
    // "ahead" or "identical" means the analyzed commit contains the source commit.
    const comparison = record(await api.get(`/repos/${repo}/compare/${sha}...${analyzed}`, 'the commit comparison'));
    if (comparison.status !== 'ahead' && comparison.status !== 'identical') stale.push(`${category || 'default'} (${analyzed})`);
  }
  return stale.length === 0 ? undefined : `the latest CodeQL analysis on main does not include ${sha}: ${stale.join(', ')}`;
}

export async function releaseGate(options: GateOptions): Promise<string[]> {
  const { repository, sourceSha, token, secretScanningToken } = options;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Expected a repository such as owner/name');
  validateSha(sourceSha);
  if (!token) throw new Error('A GitHub token is required');
  const api = client(options.apiUrl ?? 'https://api.github.com', token);
  const checks = [
    gateStatus(api, repository, sourceSha),
    codeScanningAlerts(api, repository),
    secretScanningAlerts(api, repository, secretScanningToken),
    dependabotAlerts(api, repository),
    codeqlCoverage(api, repository, sourceSha),
  ];
  const reasons: string[] = [];
  for (const result of await Promise.allSettled(checks)) {
    if (result.status === 'fulfilled') {
      if (result.value !== undefined) reasons.push(result.value);
    } else if (result.reason instanceof ReadError) {
      // A check that cannot be read refuses the release, as an open finding would.
      reasons.push(result.reason.message);
    } else {
      throw result.reason;
    }
  }
  return reasons;
}

if (import.meta.main) {
  const [repository, sourceSha] = process.argv.slice(2);
  if (!repository || !sourceSha) throw new Error('Usage: gate.ts OWNER/REPOSITORY SOURCE_SHA (token in GITHUB_TOKEN)');
  const reasons = await releaseGate({
    repository, sourceSha,
    token: process.env.GITHUB_TOKEN ?? '',
    secretScanningToken: process.env.SECRET_SCANNING_TOKEN || undefined,
    apiUrl: process.env.GITHUB_API_URL,
  });
  const summary = reasons.length === 0
    ? `Security gate passed for ${sourceSha}.\n`
    : `Security gate refused ${sourceSha}:\n\n${reasons.map((reason) => `- ${reason}`).join('\n')}\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  if (reasons.length > 0) process.exitCode = 1;
}

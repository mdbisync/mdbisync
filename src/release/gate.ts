import { appendFile } from 'node:fs/promises';
import { client, type Client, fields, type Json, ReadError } from './github-api.ts';
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
  // The user id of the GitHub App bot user that posts the security-gate
  // status (not the App id). A status of that context from anyone else
  // refuses the release.
  statusCreatorId: number;
  // The workflow token cannot read secret scanning alerts; a separate read-only token can.
  secretScanningToken?: string | undefined;
  apiUrl?: string | undefined;
}

async function gateStatus(api: Client, repo: string, sha: string, creatorId: number): Promise<string | undefined> {
  // Statuses are listed newest first; the first one of the context is its current state.
  const statuses = await api.list(`/repos/${repo}/commits/${sha}/statuses?per_page=100`, 'commit statuses');
  const latest = statuses.find((status) => status.context === GATE_STATUS);
  if (latest === undefined) return `${GATE_STATUS} status is missing on ${sha}`;
  // Anyone with write access to statuses can post this context; only the
  // configured GitHub App bot user is trusted. The type check refuses a
  // person's account whose id happens to equal the setting, as when an App
  // id is entered by mistake instead of its bot user's id.
  const creator = fields(latest.creator);
  if (creator.id !== creatorId || creator.type !== 'Bot') {
    const login = typeof creator.login === 'string' ? creator.login : 'an unknown user';
    const who = typeof creator.id === 'number' ? `${login} (id ${creator.id})` : login;
    return `${GATE_STATUS} status on ${sha} was posted by ${who}, not by the configured App bot user (id ${creatorId})`;
  }
  if (latest.state === 'success') return undefined;
  const description = typeof latest.description === 'string' && latest.description !== '' ? `: ${latest.description}` : '';
  return `${GATE_STATUS} status is ${String(latest.state)} on ${sha}${description}`;
}

async function codeScanningAlerts(api: Client, repo: string): Promise<string | undefined> {
  const alerts = await api.list(`/repos/${repo}/code-scanning/alerts?state=open&ref=refs/heads/main&per_page=100`, 'code scanning alerts');
  // A security alert of medium or higher blocks, and so does any alert of severity error.
  const blocking = alerts.filter((alert) => {
    const rule = fields(alert.rule);
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
  const blocking = alerts.filter((alert) => BLOCKING_SEVERITIES.includes(String(fields(alert.security_advisory).severity)));
  if (blocking.length === 0) return undefined;
  return `${blocking.length} open Dependabot alert(s) of medium or higher: ${blocking.map((alert) => `#${String(alert.number)}`).join(', ')}`;
}

async function codeqlCoverage(api: Client, repo: string, sha: string): Promise<string | undefined> {
  // Analyses are listed newest first; the newest of each category must have
  // succeeded and include the source commit. A category that is analyzed
  // rarely can sit on a later page, so every page is read.
  const analyses = await api.list(`/repos/${repo}/code-scanning/analyses?ref=refs/heads/main&tool_name=CodeQL&per_page=100`, 'CodeQL analyses');
  const latest = new Map<string, Json>();
  for (const analysis of analyses) {
    const category = String(analysis.category ?? '');
    if (!latest.has(category) && typeof analysis.commit_sha === 'string') latest.set(category, analysis);
  }
  if (latest.size === 0) return 'no CodeQL analysis on main';
  const failed: string[] = [];
  for (const [category, analysis] of latest) {
    const analyzed = analysis.commit_sha as string;
    const name = `${category || 'default'} (${analyzed})`;
    if (typeof analysis.error === 'string' && analysis.error !== '') {
      failed.push(`${name} failed: ${analysis.error}`);
      continue;
    }
    if (analyzed === sha) continue;
    // "ahead" or "identical" means the analyzed commit contains the source commit.
    const comparison = fields(await api.get(`/repos/${repo}/compare/${sha}...${analyzed}`, 'the commit comparison'));
    if (comparison.status !== 'ahead' && comparison.status !== 'identical') failed.push(`${name} does not include it`);
  }
  return failed.length === 0 ? undefined : `the latest CodeQL analysis on main does not cover ${sha}: ${failed.join('; ')}`;
}

// The bot user id from the workflow's setting: digits only, so '0x10', '1e3' or ' 7' never name another user.
export function parseCreatorId(value: string | undefined): number {
  return /^[1-9][0-9]*$/.test(value ?? '') ? Number(value) : Number.NaN;
}

export async function releaseGate(options: GateOptions): Promise<string[]> {
  const { repository, sourceSha, token, statusCreatorId, secretScanningToken } = options;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Expected a repository such as owner/name');
  validateSha(sourceSha);
  if (!token) throw new Error('A GitHub token is required');
  if (!Number.isSafeInteger(statusCreatorId) || statusCreatorId <= 0) throw new Error(`Expected the ${GATE_STATUS} status creator as a positive GitHub user id`);
  const api = client(options.apiUrl ?? 'https://api.github.com', token, 'mdbisync-release-gate');
  const checks = [
    gateStatus(api, repository, sourceSha, statusCreatorId),
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
  if (!repository || !sourceSha) throw new Error('Usage: gate.ts OWNER/REPOSITORY SOURCE_SHA (token in GITHUB_TOKEN, status creator id in SECURITY_GATE_CREATOR_ID)');
  const reasons = await releaseGate({
    repository, sourceSha,
    token: process.env.GITHUB_TOKEN ?? '',
    statusCreatorId: parseCreatorId(process.env.SECURITY_GATE_CREATOR_ID),
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

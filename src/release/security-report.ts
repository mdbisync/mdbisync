import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { client, type Client, fields, type Json } from './github-api.ts';
import { type Result as DependencyResult, readResult } from './dependency-scan.ts';
import { literal } from './markdown-text.ts';
import { validateSha, validateVersion } from './package.ts';

// The public security report of a final release, and the machine-readable
// summary that the security image on the project site reads. Both describe
// the release's source commit as the scans saw it: which scans ran, their
// versions, the open findings of severity high and critical, the dismissed
// findings with the reason, and the accepted risks. Raw scan output never
// enters either file.

export const REPORT_FILE = 'security-report.md';
export const SUMMARY_FILE = 'security-summary.json';
export const SUMMARY_SCHEMA = 1;
export const ACCEPTED_RISKS_FILE = 'security/accepted-risks.md';

type ToolId = 'fable' | 'astra' | 'codeql' | 'dependencies';

interface Scan {
  id: Exclude<ToolId, 'dependencies'>;
  // The name the report uses when the scan did not run.
  label: string;
  // The fixed public description of what the scan is.
  about: string;
  // How the scan's code scanning analyses are found.
  matches: (analysis: Json) => boolean;
}

// The scans the report covers, in the order the report and the image show them.
const SCANS: Scan[] = [
  {
    id: 'fable',
    label: 'Fable review',
    about: 'A whole-application security review by a language model, run on the source commit against the project\'s threat model.',
    matches: (analysis) => analysis.category === 'fable',
  },
  {
    id: 'astra',
    label: 'Astra review',
    about: 'The same whole-application review by a second, independent language model, with the same threat model and finding format.',
    matches: (analysis) => analysis.category === 'astra',
  },
  {
    id: 'codeql',
    label: 'CodeQL',
    about: 'GitHub CodeQL static analysis of the default branch, at or after the source commit.',
    matches: (analysis) => fields(analysis.tool).name === 'CodeQL',
  },
];

const DISMISSED_REASONS: Record<string, string> = {
  'false positive': 'False positive',
  "won't fix": 'Won\'t fix',
  'used in tests': 'Used in tests',
};

export interface ToolSummary {
  id: ToolId;
  // The name shown on the image, with the version the run reported (for example "Fable 5.2").
  name: string;
  high: number;
  critical: number;
}

export interface Summary {
  schema: typeof SUMMARY_SCHEMA;
  release: string;
  sourceCommit: string;
  date: string;
  report: typeof REPORT_FILE;
  // Only the tools that ran on the release, in display order.
  tools: ToolSummary[];
}

interface Finding { severity: string; title: string; reason: string }

interface ScanResult {
  scan: Scan;
  ran: boolean;
  name: string;
  version: string;
  commits: string[];
  high: number;
  critical: number;
  lower: number;
  dismissed: Finding[];
}

export interface ReportOptions {
  repository: string;
  sourceSha: string;
  version: string;
  token: string;
  // The Markdown of the accepted risks, as the repository keeps it.
  acceptedRisks: string;
  // The dependency check of the source commit, as the release gate ran it.
  dependencies: DependencyResult;
  date?: string | undefined;
  apiUrl?: string | undefined;
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'error', 'warning', 'note'];

// Known severities first, from the most severe; anything else after them.
function rank(severity: string): number {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index < 0 ? SEVERITY_ORDER.length : index;
}

function severityOf(alert: Json): string {
  const rule = fields(alert.rule);
  const level = rule.security_severity_level ?? rule.severity;
  return typeof level === 'string' && level !== '' ? level : 'unknown';
}

/**
 * The name shown for a tool: the name its run reported, followed by the
 * version it reported unless the name already ends with it. It must be
 * short, plain text, since the image and the README show it as it is.
 */
export function toolName(name: unknown, version: unknown): string {
  const base = typeof name === 'string' ? name.trim() : '';
  const suffix = typeof version === 'string' ? version.trim() : '';
  const full = suffix === '' || base.endsWith(suffix) ? base : `${base} ${suffix}`;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .+_-]{0,39}$/u.test(full)) throw new Error(`Unexpected tool name from the scan: ${JSON.stringify(full)}`);
  return full;
}

async function scanResults(api: Client, repo: string, sourceSha: string): Promise<ScanResult[]> {
  const [analyses, open, dismissed] = await Promise.all([
    api.list(`/repos/${repo}/code-scanning/analyses?ref=refs/heads/main&per_page=100`, 'code scanning analyses'),
    api.list(`/repos/${repo}/code-scanning/alerts?state=open&ref=refs/heads/main&per_page=100`, 'open code scanning alerts'),
    api.list(`/repos/${repo}/code-scanning/alerts?state=dismissed&ref=refs/heads/main&per_page=100`, 'dismissed code scanning alerts'),
  ]);
  return SCANS.map((scan) => {
    // Analyses are listed newest first. A release scanner counts only when it
    // analyzed the source commit itself; CodeQL counts with the newest analysis
    // of each of its categories, which the gate requires to cover the source.
    const own = analyses.filter((analysis) => scan.matches(analysis) && typeof analysis.commit_sha === 'string');
    const latest = new Map<string, Json>();
    for (const analysis of own) {
      if (scan.id !== 'codeql' && analysis.commit_sha !== sourceSha) continue;
      const category = String(analysis.category ?? '');
      if (!latest.has(category)) latest.set(category, analysis);
    }
    const used = [...latest.values()];
    // Alerts show only their newest instance. Once a later analysis of a review
    // category reached main, the alerts describe that commit, not the source.
    for (const analysis of used) {
      const newest = own.find((other) => other.category === analysis.category);
      if (newest !== analysis) throw new Error(`A later ${scan.label} analysis (${String(newest!.commit_sha)}) replaced the one of the source commit; the alerts no longer describe this release`);
    }
    // An analysis GitHub could not process holds no alerts; it must never read as a clean scan.
    const failed = used.filter((analysis) => typeof analysis.error === 'string' && analysis.error !== '');
    if (failed.length > 0) throw new Error(`The ${scan.label} analysis of ${String(failed[0]!.commit_sha)} failed: ${String(failed[0]!.error)}`);
    const result: ScanResult = { scan, ran: used.length > 0, name: '', version: '', commits: [], high: 0, critical: 0, lower: 0, dismissed: [] };
    if (!result.ran) return result;
    const tool = fields(used[0]!.tool);
    result.name = toolName(tool.name, scan.id === 'codeql' ? '' : tool.version);
    result.version = [...new Set(used.map((analysis) => String(fields(analysis.tool).version ?? '')).filter(Boolean))].join(', ');
    result.commits = [...new Set(used.map((analysis) => analysis.commit_sha as string))];
    const categories = new Set(used.map((analysis) => String(analysis.category ?? '')));
    const toolNames = new Set(used.map((analysis) => fields(analysis.tool).name));
    // An alert belongs to the release while one of the analyzed commits is its newest instance.
    const belongs = (alert: Json) => {
      const instance = fields(alert.most_recent_instance);
      return toolNames.has(fields(alert.tool).name) && categories.has(String(instance.category ?? ''))
        && result.commits.includes(String(instance.commit_sha));
    };
    for (const alert of open.filter(belongs)) {
      const severity = severityOf(alert);
      if (severity === 'critical') result.critical += 1;
      else if (severity === 'high') result.high += 1;
      else result.lower += 1;
    }
    result.dismissed = dismissed
      .filter(belongs)
      .map((alert) => {
        const rule = fields(alert.rule);
        const title = [rule.description, rule.name, rule.id].find((value) => typeof value === 'string' && value.trim() !== '') as string | undefined;
        const reason = typeof alert.dismissed_reason === 'string' ? alert.dismissed_reason : '';
        return { severity: severityOf(alert), title: title ?? 'Untitled finding', reason: DISMISSED_REASONS[reason] ?? 'Dismissed' };
      })
      .sort((a, b) => rank(a.severity) - rank(b.severity) || a.title.localeCompare(b.title));
    return result;
  });
}

/** The accepted risks as entries of the report: each `## ` entry of the repository's file, one level down. */
export function acceptedRiskEntries(markdown: string): string {
  const start = markdown.search(/^## /m);
  if (start < 0) return 'None.\n';
  return `${markdown.slice(start).replace(/^(#{2,5}) /gm, '#$1 ').trimEnd()}\n`;
}

function renderReport(options: { version: string; sourceSha: string; date: string; scans: ScanResult[]; acceptedRisks: string }): string {
  const { version, sourceSha, date, scans } = options;
  const ran = scans.filter((scan) => scan.ran);
  const lines = [
    `# Security report for mdbisync ${version}`,
    '',
    `Source commit: \`${sourceSha}\`. Report date: ${date}.`,
    '',
    'Every scan below ran before the release was built: the language-model reviews',
    'on its source commit, CodeQL on the default branch at or after it (the',
    '"Analyzed commit" column names the commit). A release is built only when no',
    'scan has an open finding of medium severity or higher. A clean result is not',
    'a proof of security, least of all from a language model: it means only that',
    'this scan found nothing it could trace.',
    '',
    '## Summary',
    '',
    '| Scan | Version | Analyzed commit | Open critical | Open high | Open, lower severity | Dismissed |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...ran.map((scan) => `| ${literal(scan.name)} | ${literal(scan.version || 'not reported')} | ${scan.commits.map((sha) => `\`${sha.slice(0, 12)}\``).join(', ')} | ${scan.critical} | ${scan.high} | ${scan.lower} | ${scan.dismissed.length} |`),
    '',
  ];
  const skipped = scans.filter((scan) => !scan.ran);
  if (skipped.length > 0) {
    lines.push(`Did not run on this release: ${skipped.map((scan) => scan.scan.label).join(', ')}.`, '');
  }
  for (const scan of ran) {
    lines.push(`## ${literal(scan.name)}`, '', scan.scan.about, '');
    lines.push(`Open findings: ${scan.critical} critical, ${scan.high} high, ${scan.lower} of lower severity.`, '');
    if (scan.dismissed.length === 0) {
      lines.push('Dismissed findings: none.', '');
    } else {
      lines.push('Dismissed findings:', '', '| Severity | Finding | Reason |', '| --- | --- | --- |');
      for (const finding of scan.dismissed) lines.push(`| ${literal(finding.severity)} | ${literal(finding.title)} | ${finding.reason} |`);
      lines.push('');
    }
  }
  lines.push('## Accepted risks', '', 'Known risks that the project accepted instead of closing, with the reason and', 'what you can do about each. A finding behind an accepted risk counts here,', 'not as fixed.', '');
  return `${lines.join('\n')}\n${acceptedRiskEntries(options.acceptedRisks)}`;
}

export async function securityReport(options: ReportOptions): Promise<{ report: string; summary: Summary }> {
  const { repository, sourceSha, version, token } = options;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Expected a repository such as owner/name');
  validateSha(sourceSha);
  validateVersion(version);
  if (version.includes('-')) throw new Error('A security report is written only for a final version');
  if (!token) throw new Error('A GitHub token is required');
  const api = client(options.apiUrl ?? 'https://api.github.com', token, 'mdbisync-release-report');
  if (options.dependencies.commit !== sourceSha) throw new Error(`The dependency scan checked ${options.dependencies.commit}, not ${sourceSha}`);
  const scans = await scanResults(api, repository, sourceSha);
  const dependencies = { high: options.dependencies.counts.high, critical: options.dependencies.counts.critical };
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const summary: Summary = {
    schema: SUMMARY_SCHEMA,
    release: version,
    sourceCommit: sourceSha,
    date,
    report: REPORT_FILE,
    tools: [
      ...scans.filter((scan) => scan.ran).map((scan) => ({ id: scan.scan.id, name: scan.name, high: scan.high, critical: scan.critical })),
      { id: 'dependencies', name: 'Dependencies', ...dependencies },
    ],
  };
  return { report: renderReport({ version, sourceSha, date, scans, acceptedRisks: options.acceptedRisks }), summary };
}

if (import.meta.main) {
  const [repository, sourceSha, version, dependencyResult, output] = process.argv.slice(2);
  if (!repository || !sourceSha || !version || !dependencyResult || !output) throw new Error('Usage: security-report.ts OWNER/REPOSITORY SOURCE_SHA VERSION DEPENDENCY_RESULT OUTPUT_DIRECTORY (token in GITHUB_TOKEN)');
  const { report, summary } = await securityReport({
    repository, sourceSha, version,
    token: process.env.GITHUB_TOKEN ?? '',
    acceptedRisks: await readFile(ACCEPTED_RISKS_FILE, 'utf8'),
    dependencies: await readResult(dependencyResult),
    apiUrl: process.env.GITHUB_API_URL,
  });
  await mkdir(output, { recursive: true });
  await writeFile(join(output, REPORT_FILE), report);
  await writeFile(join(output, SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`);
  // Only the counts go to the log; the report itself waits in the draft release for a maintainer.
  console.log(summary.tools.map((tool) => `${tool.id}: ${tool.critical} critical, ${tool.high} high`).join('\n'));
}

// Reports: a JSON and a Markdown report per harness run, a status page with
// the latest result of every scenario, and an evidence summary. Reports hold
// ids, results, reasons, counts and timings; never document content.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS, unexpectedPasses, type Result, type ScenarioResult } from './results.ts';
import { LEVELS, levelOf, type Level } from './spec.ts';

export const LEVEL_TITLES: Record<Level, string> = {
  L0: 'Format',
  L1: 'Initial sync git → Linear',
  L1R: 'Initial sync Linear → git',
  L2: 'One side',
  L3: 'Conflicts',
  L4: 'Concurrency',
  L5: 'Errors and recovery',
  L6: 'Linear UI',
};

export interface HarnessReport {
  harnessRunId: string;
  startedAt: string;
  finishedAt: string;
  host: string;
  selection: Record<string, unknown>;
  results: ScenarioResult[];
}

export function countByResult(results: readonly ScenarioResult[]): Record<Result, number> {
  const counts = Object.fromEntries(RESULTS.map((result) => [result, 0])) as Record<Result, number>;
  for (const result of results) counts[result.result] += 1;
  return counts;
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function renderRunMarkdown(report: HarnessReport): string {
  const counts = countByResult(report.results);
  const lines = [
    `# Scenario run ${report.harnessRunId}`,
    '',
    `Started ${report.startedAt}, finished ${report.finishedAt}.`,
    '',
    `| ${RESULTS.join(' | ')} |`,
    `| ${RESULTS.map(() => '---').join(' | ')} |`,
    `| ${RESULTS.map((result) => counts[result]).join(' | ')} |`,
    '',
    ...(report.selection['teams'] === undefined ? [] : [`Partial corpus: selected teams ${JSON.stringify(report.selection['teams'])}. These results do not replace full catalog status.`, '']),
    '| Scenario | Run | Result | Reason | Engine requests | Harness app reads | Seconds | Cleanup |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const result of report.results) {
    lines.push(`| ${result.id} | ${result.runId} | ${result.result}${result.unexpectedPass ? ' (expected red)' : ''} | ${cell(result.reason ?? '')} | ${result.engineRequests} | ${result.harnessAppRequests} | ${Math.round(result.durationMs / 1000)} | ${result.cleanup.ok ? 'ok' : cell(result.cleanup.detail ?? 'failed')} |`);
  }
  const limits = report.results.filter((result) => result.workflowRateLimits !== undefined);
  if (limits.length > 0) {
    lines.push('', '## Workflow rate-limit evidence', '',
      'Response samples and the governor snapshot are retained in report.json. A selected response is cached evidence; admission uses the fresh budget unless a concurrent response constrains it.', '',
      '| Scenario | App | Response samples | Selected requests sample | Selected complexity sample | Admission sources |',
      '| --- | --- | --- | --- | --- | --- |');
    for (const result of limits) {
      const evidence = result.workflowRateLimits!;
      const selected = evidence.governor?.selected;
      const sample = (value: { at: number; remaining: number } | undefined) => value === undefined ? 'none' : `${new Date(value.at).toISOString()} (${value.remaining} remaining)`;
      lines.push(`| ${result.id} | ${cell(evidence.app)} | ${evidence.samples.length} | ${sample(selected?.requests)} | ${sample(selected?.complexity)} | ${cell(JSON.stringify(evidence.admission?.decision ?? null))} |`);
    }
  }
  const passing = unexpectedPasses(report.results);
  if (passing.length > 0) lines.push('', `Passing while on the expected-red list, which fails the run (remove them from the list): ${passing.join(', ')}.`);
  const answers = report.results.flatMap((result) => Object.entries(result.answerSizes ?? {}).map(([operation, size]) => ({ id: result.id, operation, size })));
  if (answers.length > 0) {
    // The largest answers: content pages near the transport's timeout show here.
    const largest = answers.sort((a, b) => b.size.maxBytes - a.size.maxBytes).slice(0, 10);
    lines.push('', '## Largest engine answers', '', '| Scenario | Operation | Answers | Largest bytes | Its seconds | Slowest seconds |', '| --- | --- | --- | --- | --- | --- |');
    for (const { id, operation, size } of largest) lines.push(`| ${id} | ${cell(operation)} | ${size.count} | ${size.maxBytes} | ${(size.maxBytesDurationMs / 1000).toFixed(1)} | ${(size.maxDurationMs / 1000).toFixed(1)} |`);
  }
  const marks = report.results.filter((result) => result.conflictMarks !== undefined);
  if (marks.length > 0) {
    lines.push('', '## Conflict marks after the checks', '', '| Scenario | Mapped | Path | Mark | Saved own icon | Comments |', '| --- | --- | --- | --- | --- | --- |');
    for (const result of marks) {
      const { mapped, marked } = result.conflictMarks as NonNullable<typeof result.conflictMarks>;
      if (marked.length === 0) lines.push(`| ${result.id} | ${mapped} | none |  |  |  |`);
      for (const mark of marked) lines.push(`| ${result.id} | ${mapped} | ${cell(mark.path)} | ${mark.icon}/${mark.color} | ${mark.saved === null ? 'none' : `${mark.saved.icon ?? 'none'}/${mark.saved.color ?? 'none'}`} | ${mark.comments} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function writeRunReport(report: HarnessReport, outDir: string): { json: string; markdown: string } {
  mkdirSync(outDir, { recursive: true });
  const json = join(outDir, 'report.json');
  const markdown = join(outDir, 'report.md');
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdown, renderRunMarkdown(report));
  return { json, markdown };
}

// --- the status page ----------------------------------------------------------

export interface LatestResult {
  id: string;
  result: Result;
  reason?: string;
  runId: string;
  at: string;
  harnessRunId: string;
}

/** Merges new results into the latest-per-scenario record; skipped results do not replace a real one. */
export function mergeLatest(previous: readonly LatestResult[], report: HarnessReport): LatestResult[] {
  if (report.selection['teams'] !== undefined) return [...previous];
  const latest = new Map(previous.map((entry) => [entry.id, entry]));
  for (const result of report.results) {
    if (result.corpusTeams !== undefined) continue;
    if (result.result === 'skipped' && latest.has(result.id)) continue;
    latest.set(result.id, {
      id: result.id,
      result: result.result,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      runId: result.runId,
      at: result.startedAt,
      harnessRunId: report.harnessRunId,
    });
  }
  return [...latest.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

/** The latest results are kept in a JSON block inside the page, so the page is its own source. */
const DATA_START = '<!-- latest-results';
const DATA_END = 'latest-results -->';

export function readLatest(pageText: string): LatestResult[] {
  const start = pageText.indexOf(DATA_START);
  const end = pageText.indexOf(DATA_END);
  if (start < 0 || end < 0) return [];
  return JSON.parse(pageText.slice(start + DATA_START.length, end)) as LatestResult[];
}

export function renderStatusPage(catalog: readonly string[], latest: readonly LatestResult[], keep: { frontMatter: string; preserved: string }): string {
  const byId = new Map(latest.map((entry) => [entry.id, entry]));
  const lines = [
    keep.frontMatter.trimEnd(),
    '',
    '# Test status',
    '',
    'The harness rewrites this page from the latest result of each scenario of',
    'the test plan. A scenario that never ran is `not run`.',
    '',
    '| Level | Scenarios | pass | expected-red | env-blocked | fail | skipped | not run |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const level of LEVELS) {
    const ids = catalog.filter((id) => levelOf(id) === level);
    const count = (result: Result) => ids.filter((id) => byId.get(id)?.result === result).length;
    const notRun = ids.filter((id) => !byId.has(id)).length;
    lines.push(`| ${level} ${LEVEL_TITLES[level]} | ${ids.length} | ${count('pass')} | ${count('expected-red')} | ${count('env-blocked')} | ${count('fail')} | ${count('skipped')} | ${notRun} |`);
  }
  lines.push('', '## Scenarios', '', '| Scenario | Result | Reason | Run | When |', '| --- | --- | --- | --- | --- |');
  for (const id of catalog) {
    const entry = byId.get(id);
    lines.push(entry === undefined ? `| ${id} | not run | | | |` : `| ${id} | ${entry.result} | ${cell(entry.reason ?? '')} | ${entry.harnessRunId}/${entry.runId} | ${entry.at.slice(0, 16).replace('T', ' ')} |`);
  }
  if (keep.preserved.trim() !== '') lines.push('', keep.preserved.trim());
  lines.push('', DATA_START, JSON.stringify(latest, null, 1), DATA_END, '');
  return lines.join('\n');
}

/**
 * Rewrites the status page: front matter and any section headed by a level-2
 * heading that the harness does not own (such as notes on the UI
 * environment) are kept.
 */
export function updateStatusPage(file: string, catalog: readonly string[], report: HarnessReport): void {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const frontMatter = /^---\n[\s\S]*?\n---\n/.exec(text)?.[0] ?? '---\nstatus: generated\n---\n';
  const body = text.slice(frontMatter.length).split(DATA_START)[0] ?? '';
  const sections = body.split(/^(?=## )/m).filter((section) => section.startsWith('## ') && !section.startsWith('## Scenarios'));
  const latest = mergeLatest(readLatest(text), report);
  writeFileSync(file, renderStatusPage(catalog, latest, { frontMatter, preserved: sections.join('\n') }));
}

// --- evidence ------------------------------------------------------------------

/** A summary for the evidence folder: counts, timings and requests, without reasons that could name paths. */
export function evidenceSummary(report: HarnessReport): string {
  const counts = countByResult(report.results);
  const engine = report.results.reduce((sum, result) => sum + result.engineRequests, 0);
  const harness = report.results.reduce((sum, result) => sum + result.harnessRequests, 0);
  const appReads = report.results.reduce((sum, result) => sum + result.harnessAppRequests, 0);
  const waited = report.results.reduce((sum, result) => sum + result.budgetWaitMs, 0);
  const cleanupFailures = report.results.filter((result) => !result.cleanup.ok).map((result) => result.id);
  const passing = unexpectedPasses(report.results);
  const lines = [
    `# Evidence: scenario run ${report.harnessRunId}`,
    '',
    `- Host: ${report.host}; started ${report.startedAt}; finished ${report.finishedAt}.`,
    ...(report.selection['teams'] === undefined ? [] : [`- Partial corpus: selected teams ${JSON.stringify(report.selection['teams'])}; these results do not replace full catalog status.`]),
    `- Scenarios: ${report.results.length}; ${RESULTS.map((result) => `${result}: ${counts[result]}`).join(', ')}.`,
    `- Linear requests: engine ${engine}, harness editors ${harness}, harness app reads ${appReads}; budget waits ${Math.round(waited / 1000)} s.`,
    `- Cleanup failures: ${cleanupFailures.length === 0 ? 'none' : cleanupFailures.join(', ')}.`,
    `- Unexpected passes (fail the run; remove them from the expected-red list): ${passing.length === 0 ? 'none' : passing.join(', ')}.`,
    '',
    '| Scenario | Result | Harness app reads | Reason |',
    '| --- | --- | --- | --- |',
    ...report.results.map((result) => `| ${result.id} | ${result.result} | ${result.harnessAppRequests} | ${cell(result.reason ?? '')} |`),
  ];
  return `${lines.join('\n')}\n`;
}

export function writeEvidence(report: HarnessReport, evidenceRoot: string): string {
  const dir = join(evidenceRoot, report.harnessRunId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.md'), evidenceSummary(report));
  writeFileSync(join(dir, 'results.json'), `${JSON.stringify(report.results.map(({ checks, ...rest }) => ({ ...rest, checks: checks.map(({ name, ok }) => ({ name, ok })) })), null, 2)}\n`);
  return dir;
}

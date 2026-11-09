// The job summary of the setup check: a table of names and states. It never
// holds document content.

import { type SetupReport } from './report.ts';
import { type StateRefusal } from './state.ts';

const MARK = { passed: 'passed', failed: 'FAILED', warning: 'warning', 'not-checked': 'not checked' } as const;

export function renderSetupSummary(report: SetupReport): string {
  const lines = [
    '## Setup check',
    '',
    report.ok ? 'Every required item passed.' : `Stopped before any write: \`${report.code}\`.`,
    '',
    '| Item | State | Detail |',
    '| --- | --- | --- |',
    ...report.checks.map((check) => `| ${check.name} | ${MARK[check.state]} | ${escapeCell(check.detail)} |`),
    '',
  ];
  return lines.join('\n');
}

export function renderStateRefusal(refusal: StateRefusal): string {
  return ['## Sync', '', `Stopped before any write: \`${refusal.code}\`.`, '', refusal.message, ''].join('\n');
}

/** A table cell: backslashes first, so a `\` before a `|` cannot undo the pipe's escape. */
function escapeCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

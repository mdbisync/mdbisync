// The job summary of the setup check: a table of names and states, and for
// a failure the quickstart section that fixes it. It never holds document
// content.

import { cell } from '../run/summary.ts';
import { FIX_ANCHORS, QUICKSTART_URL, fixUrl } from './fixes.ts';
import { type SetupReport } from './report.ts';
import { type StateRefusal } from './state.ts';

const MARK = { passed: 'passed', failed: 'FAILED', warning: 'warning', 'not-checked': 'not checked' } as const;

export function renderSetupSummary(report: SetupReport): string {
  const fix = fixUrl(report.code);
  const lines = [
    '## Setup check',
    '',
    report.ok ? 'Every required item passed.' : `Stopped before any write: \`${report.code}\`.${fix === undefined ? '' : ` How to fix it: ${fix}`}`,
    '',
    '| Item | State | Detail |',
    '| --- | --- | --- |',
    ...report.checks.map((check) => {
      const link = check.state === 'failed' ? fixUrl(check.code) : undefined;
      return `| ${check.name} | ${MARK[check.state]} | ${cell(check.detail)}${link === undefined ? '' : ` ([how to fix](${link}))`} |`;
    }),
    '',
  ];
  return lines.join('\n');
}

export function renderStateRefusal(refusal: StateRefusal): string {
  return ['## Sync', '', `Stopped before any write: \`${refusal.code}\`.`, '', refusal.message, '', `How to fix it: ${QUICKSTART_URL}#${FIX_ANCHORS[refusal.code]}`, ''].join('\n');
}

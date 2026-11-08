// Command line for the format probe.
//
//   node test/probe/run.ts [--update] [--report <file>] [--report-title <title>]
//                          [--json <file>] [--only <text>] [--no-facts]
//
// Needs LINEAR_TEST_APP_CLIENT_ID and LINEAR_TEST_APP_CLIENT_SECRET (an OAuth
// app with client credentials, read and write). Optional: LINEAR_TEST_TEAM_KEY
// (default: the first team), LINEAR_BASE_URL (a proxy in front of Linear).
//
// Without --update it compares Linear's forms with the recorded ones beside
// the fixtures and exits 1 on drift. With --update it records this run's forms.
// Exit 2: the run could not finish (missing credentials, stopped by a rate
// limit, a token left unrevoked); the projects it made are deleted either way.

import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { LinearClient, RequestStats, withRunToken } from '../../src/linear/index.ts';
import { loadBank } from './bank.ts';
import { runProbe, type ProbeRun } from './probe.ts';
import { findDrift, writeRecord } from './record.ts';
import { renderReport } from './report.ts';

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      update: { type: 'boolean', default: false },
      report: { type: 'string' },
      'report-title': { type: 'string' },
      json: { type: 'string' },
      only: { type: 'string' },
      'no-facts': { type: 'boolean', default: false },
      'bank-dir': { type: 'string' },
    },
  });
  const clientId = env.LINEAR_TEST_APP_CLIENT_ID;
  const clientSecret = env.LINEAR_TEST_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error('format probe: LINEAR_TEST_APP_CLIENT_ID and LINEAR_TEST_APP_CLIENT_SECRET are required');
    return 2;
  }
  const baseUrl = env.LINEAR_BASE_URL;
  const bank = loadBank(values['bank-dir']);
  const stats = new RequestStats();
  const complexityLog = new Map<string, number | undefined>();
  const runId = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`;

  let run: ProbeRun;
  try {
    run = await withRunToken(
      { clientId, clientSecret },
      { baseUrl, stats, onRevokeError: () => console.error('format probe: the run token could not be revoked') },
      (token) => {
        const client = new LinearClient({
          token: token.accessToken,
          baseUrl,
          stats,
          hooks: {
            // The highest cost seen per operation: a full page costs more than a short one.
            afterResponse: (info) => {
              const cost = info.rateLimit.complexity;
              if (cost !== undefined && cost > (complexityLog.get(info.operation) ?? -1)) complexityLog.set(info.operation, cost);
            },
          },
        });
        return runProbe({
          client,
          bank,
          runId,
          teamKey: env.LINEAR_TEST_TEAM_KEY,
          only: values.only,
          facts: !values['no-facts'],
          complexityLog,
          log: (line) => console.error(`format probe: ${line}`),
        });
      },
    );
  } catch (error) {
    console.error(`format probe: run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`format probe: ${stats.total} API requests sent`);
    return 2;
  }
  run.requests = stats.toJSON();

  const drift = values.update ? [] : findDrift(bank, run);
  if (values.update) writeRecord(bank, run);
  if (values.report) writeFileSync(values.report, renderReport(run, { title: values['report-title'], drift, updated: values.update }));
  if (values.json) writeFileSync(values.json, `${JSON.stringify({ ...run, fixtures: run.fixtures.map(({ source: _s, yjs: _y, ...rest }) => rest), drift }, null, 2)}\n`);

  const notFixed = run.fixtures.filter((r) => r.fixedPoint === false).length;
  console.error(
    `format probe: ${run.fixtures.length} fixtures, ${run.fixtures.filter((r) => r.refused).length} refused, ` +
      `${notFixed} without a fixed point, ${drift.length} drifted, ${stats.total} API requests`,
  );
  for (const entry of drift) console.error(`drift: ${entry.file}: ${entry.kind}: ${entry.detail}`);
  if (run.cleanup.some((line) => line.includes('NOT deleted'))) return 2;
  return drift.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}

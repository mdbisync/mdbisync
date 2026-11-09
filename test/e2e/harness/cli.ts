// The harness's command line.
//
//   node test/e2e/harness/cli.ts run [--ids L1-04,L2-01] [--levels L1,L2] [--slices mini]
//        [--modes local] [--workers 4] [--out <dir>] [--status-page <file>] [--evidence-dir <dir>]
//   node test/e2e/harness/cli.ts plan  [same filters]   lists what would run, with budget estimates
//   node test/e2e/harness/cli.ts sweep                  removes leftovers of dead or old runs
//   node test/e2e/harness/cli.ts checklist --ids L6-05  prints a UI checklist without running
//   node test/e2e/harness/cli.ts ui-result <run folder> <answered checklist> [--status-page <file>] [--evidence-dir <dir>]
//        takes up a run held for its UI steps with the UI session's answers
//
// The test configuration comes from the environment and the test
// configuration folder (see config.ts).

import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { LinearClient, mintAppToken, revokeToken, type RunToken, type LogEntry, type LinearHooks } from '../../../src/linear/index.ts';
import { countAppRequest } from './app-reads.ts';
import { loadTestConfig } from './config.ts';
import { REPO_ROOT } from './engine.ts';
import { Governor, budgetFromStatus, estimate, type App } from './governor.ts';
import { SandboxRest, githubToken } from './github.ts';
import { newRunId, runNames } from './isolation.ts';
import { LinearWorld, editorClient } from './linear-world.ts';
import { defaultStateDir } from './locks.ts';
import { updateStatusPage, writeEvidence, writeRunReport, type HarnessReport } from './report.ts';
import { loadExpectedRed } from './results.ts';
import { runScenarios, skippedResult } from './runner.ts';
import { Sandbox } from './sandbox.ts';
import { loadScenarios, selectScenarios } from './spec.ts';
import { sweep } from './sweeper.ts';
import { parseUiAnswers, renderUiChecklist } from './ui-checklist.ts';
import { loadHeldRun } from './held-run.ts';
import { recordUiResult, reportDirOf, reportEntry, takeUpHeldRun } from './ui-result.ts';

const list = (value: string | undefined) => (value === undefined ? undefined : value.split(',').map((item) => item.trim()).filter(Boolean));

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ids: { type: 'string' },
      levels: { type: 'string' },
      slices: { type: 'string' },
      modes: { type: 'string' },
      workers: { type: 'string', default: '4' },
      out: { type: 'string' },
      'status-page': { type: 'string' },
      'evidence-dir': { type: 'string' },
      defer: { type: 'string' },
    },
  });
  const command = positionals[0] ?? 'help';
  const log = (line: string) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
  const all = loadScenarios();
  const selection = { ids: list(values.ids), levels: list(values.levels), slices: list(values.slices), modes: list(values.modes) };
  const cleanSelection = Object.fromEntries(Object.entries(selection).filter(([, value]) => value !== undefined));
  const scenarios = selectScenarios(all, cleanSelection);
  const workers = Number(values.workers);
  if (!Number.isInteger(workers) || workers < 1) throw new Error(`--workers must be a whole number of at least 1, not ${values.workers}`);
  const stateDir = defaultStateDir();
  const config = loadTestConfig();

  if (command === 'plan') {
    for (const scenario of scenarios) {
      const need = estimate(scenario);
      process.stdout.write(`${scenario.id}\t${scenario.slice}\t${scenario.mode}\t${scenario.setup.state}\t~${need.requests} requests\n`);
    }
    process.stdout.write(`${scenarios.length} scenarios\n`);
    return 0;
  }

  if (command === 'checklist') {
    for (const scenario of scenarios.filter((candidate) => candidate.mode === 'ui')) {
      process.stdout.write(renderUiChecklist(scenario, runNames('000000'), { live: null, runDir: '<run folder>' }));
      process.stdout.write('\n');
    }
    return 0;
  }

  // Live commands mint one token per OAuth app for the harness's own reads and revoke it at the end.
  const appClients = new Map<string, LinearClient>();
  const tokens: Array<{ token: RunToken; hooks: LinearHooks }> = [];
  const harnessRunId = `${new Date().toISOString().slice(0, 10)}-${newRunId()}`;
  const hooksFor = (app: string) => ({
    beforeRequest: countAppRequest,
    log: (entry: LogEntry) => { process.stderr.write(`${JSON.stringify({ harnessRunId, app, ...entry })}\n`); },
  });
  try {
    for (const app of command === 'run' || command === 'ui-result' ? config.linearApps : []) {
      const hooks = hooksFor(app.name);
      const token = await mintAppToken({ clientId: app.clientId, clientSecret: app.clientSecret }, { hooks });
      tokens.push({ token, hooks });
      appClients.set(app.name, new LinearClient({ token: token.accessToken, auth: token.context, hooks }));
    }

    if (command === 'sweep') {
      if (config.missing.length > 0) throw new Error(`test configuration is missing: ${config.missing.join(', ')}`);
      const token = await githubToken(config, 'local');
      const world = new LinearWorld(editorClient(config.editors['editor-a']));
      const teams = await world.teams();
      const report = await sweep(
        {
          sandbox: new Sandbox({ url: config.gitUrl, token: token.token, stateDir, runId: 'sweep0' }),
          rest: new SandboxRest(config, token.token),
          world,
          teamIds: teams.map((team) => team.id),
        },
        stateDir,
      );
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.errors.length === 0 ? 0 : 1;
    }

    if (command === 'run') {
      const outDir = values.out ?? join(REPO_ROOT, 'test/e2e/out', harnessRunId);
      const apps: App[] = config.linearApps.map((app) => ({
        name: app.name,
        readBudget: async () => budgetFromStatus(await (appClients.get(app.name) as LinearClient).rateLimitStatus(), Date.now()),
      }));
      const governor = apps.length === 0 ? null : new Governor({ apps, stateDir, log });
      const startedAt = new Date().toISOString();
      log(`run ${harnessRunId}: ${scenarios.length} scenarios, ${values.workers} workers, output ${outDir}`);
      // SIGINT or SIGTERM: running scenarios finish with their cleanup, the rest are skipped.
      const stop = { requested: false };
      const onSignal = (signal: string) => {
        if (stop.requested) {
          log(`${signal} again: stopping now; the sweeper removes what the running scenarios leave`);
          process.exit(130);
        }
        stop.requested = true;
        log(`${signal}: finishing the running scenarios, skipping the rest`);
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      // --defer: selected scenarios reported skipped (for example to keep a heavy one for a quiet budget window).
      const deferred = new Set(list(values.defer) ?? []);
      const ran = await runScenarios(scenarios.filter((s) => !deferred.has(s.id)), { config, governor, appClients, stateDir, outDir, expectedRed: loadExpectedRed(), log }, workers, stop);
      const byId = new Map(ran.map((result) => [result.id, result]));
      const results = scenarios.map((s) => byId.get(s.id) ?? skippedResult(s, 'deferred to a later run'));
      const report: HarnessReport = { harnessRunId, startedAt, finishedAt: new Date().toISOString(), host: hostname(), selection: cleanSelection, results };
      const files = writeRunReport(report, outDir);
      log(`report: ${files.markdown}`);
      if (values['status-page'] !== undefined) updateStatusPage(values['status-page'], all.map((scenario) => scenario.id), report);
      if (values['evidence-dir'] !== undefined) log(`evidence: ${writeEvidence(report, values['evidence-dir'])}`);
      return results.some((result) => result.result === 'fail') ? 1 : 0;
    }

    if (command === 'ui-result') {
      const [, runArg, checklistArg] = positionals;
      if (runArg === undefined || checklistArg === undefined) throw new Error('usage: cli.ts ui-result <run folder> <answered checklist>');
      const runDir = resolve(runArg);
      const answers = parseUiAnswers(readFileSync(checklistArg, 'utf8'));
      const held = loadHeldRun(runDir);
      // The result goes over the run's entry in its report: a run folder without one is refused before anything changes.
      reportEntry(reportDirOf(runDir), held.scenarioId, held.runId);
      // Admission on the run's own app: its engine and the harness's reads go through that app.
      const apps: App[] = config.linearApps.filter((app) => app.name === held.appName).map((app) => ({
        name: app.name,
        readBudget: async () => budgetFromStatus(await (appClients.get(app.name) as LinearClient).rateLimitStatus(), Date.now()),
      }));
      if (config.linearApps.length > 0 && apps.length === 0) throw new Error(`the held run uses app ${held.appName}, which the test configuration does not have`);
      const governor = apps.length === 0 ? null : new Governor({ apps, stateDir, log });
      const outcome = await takeUpHeldRun(runDir, answers, all, { config, governor, appClients, stateDir, expectedRed: loadExpectedRed(), log });
      if (outcome.state === 'waiting') {
        process.stdout.write(`ran ${outcome.ran.length === 0 ? 'no harness step' : outcome.ran.join(', ')}; the run stays held: answer item ${outcome.nextItem} and the ones after it, then hand the checklist back\n`);
        return 0;
      }
      const { result } = outcome;
      const { files, statusPage } = recordUiResult(runDir, result, {
        catalog: all.map((scenario) => scenario.id),
        ...(values['status-page'] === undefined ? {} : { statusPage: values['status-page'] }),
        ...(values['evidence-dir'] === undefined ? {} : { evidenceDir: values['evidence-dir'] }),
      });
      if (statusPage === 'kept-newer') log(`status page: kept a newer result of ${result.id} from another run`);
      process.stdout.write(`${result.id} ${result.runId}: ${result.result}${result.reason === undefined ? '' : ` (${result.reason})`}; cleanup ${result.cleanup.ok ? 'ok' : `failed: ${result.cleanup.detail ?? ''}`}; report ${files.markdown}\n`);
      return result.result === 'fail' || !result.cleanup.ok ? 1 : 0;
    }

    process.stdout.write('Usage: cli.ts run|plan|sweep|checklist|ui-result [--ids ...] [--levels ...] [--slices ...] [--modes ...]\n');
    return command === 'help' ? 0 : 2;
  } finally {
    for (const { token, hooks } of tokens) {
      try {
        await revokeToken(token.accessToken, { hooks, auth: token.context });
      } catch {
        log('warning: a harness token was not revoked; it expires on its own');
      }
    }
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

// The harness's command line.
//
//   node test/e2e/harness/cli.ts run [--ids L1-04,L2-01] [--levels L1,L2] [--slices mini]
//        [--modes local] [--workers 4] [--out <dir>] [--status-page <file>] [--evidence-dir <dir>]
//   node test/e2e/harness/cli.ts plan  [same filters]   lists what would run, with budget estimates
//   node test/e2e/harness/cli.ts recover <run id> --writer-stopped   recover only after verifying all writers stopped
//   node test/e2e/harness/cli.ts sweep                  removes leftovers of dead or old runs
//   node test/e2e/harness/cli.ts checklist --ids L6-05  prints a UI checklist without running
//   node test/e2e/harness/cli.ts ui-result <run folder> <answered checklist> [--status-page <file>] [--evidence-dir <dir>]
//        takes up a run held for its UI steps with the UI session's answers
//   node test/e2e/harness/cli.ts scheduler [--install]
//        prints the sandbox's scheduled sync workflow for the release under test; --install commits it
//        to the sandbox's default branch (workflow-files.ts, renderScheduler)
//   node test/e2e/harness/cli.ts dispatch-check [--keep-run]
//        runs docs/own-scheduler.md's dispatch script, as published, against the
//        sandbox: with an App token without Actions write (expects HTTP 403 and
//        exit 1), then with one with it (expects a run of mdbisync.yml on main
//        within a minute, cancelled at once unless --keep-run). Prints the
//        record as JSON; exit 0 when both cases behave as the page says, 1 when
//        not, 3 when the check could not run and dispatched nothing
//        (dispatch-check.ts). Needs the GitHub App; it dispatches live.
//   node test/e2e/harness/cli.ts walkthrough prepare|push|dispatch|wait|list|cancel
//        --run <six hex> [--dir <clone>] [--ref t/<run>/main]
//        [--workflow mdbisync-initial-sync.yml] [--input direction=git-to-linear]
//        [--input confirm=false] [--run-number <id>]
//        prepare adapts local copied workflows; review and commit before push.
//        dispatch waits up to 30 minutes and prints the conclusion and summary.
//        Live commands need an admitted manual run's isolation/cleanup window.
//   node test/e2e/harness/cli.ts walkthrough project|trash|linear-edit|linear-read|cleanup
//        --run <six hex> [--team ENG] [--path docs/notes.md] [--text <line>]
//        project creates "Field notes <run>" in the team; trash reads zone trash
//        counts (the first reading is the baseline); linear-edit appends one
//        neutral line to a synced document; linear-read prints it; cleanup
//        archives the run's projects and documents (never trashes them),
//        closes its pull requests and deletes its refs, with trash counts.
//
// The test configuration comes from the environment and the test
// configuration folder (see config.ts).

import { createHash, randomUUID } from 'node:crypto';
import { GitStateStore, SharedAdmission, refreshingGitEnv } from './shared-state.ts';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { LinearClient, mintAppToken, revokeToken, type RunToken, type LogEntry, type LinearHooks } from '../../../src/linear/index.ts';
import { countAppRequest } from './app-reads.ts';
import { loadTestConfig } from './config.ts';
import { REPO_ROOT } from './engine.ts';
import { Governor, budgetFromStatus, estimate, type App } from './governor.ts';
import { tokenLease } from './token-lease.ts';
import { SandboxRest, githubToken } from './github.ts';
import { newRunId, runNames, RUN_ID_PATTERN } from './isolation.ts';
import { LinearWorld, editorClient } from './linear-world.ts';
import { acquireLock, defaultStateDir, forgetRun, registerRun, requireStoppedLocalRun } from './locks.ts';
import { updateStatusPage, writeEvidence, writeRunReport, type HarnessReport } from './report.ts';
import { EnvBlockedError, gateExitCode, loadExpectedRed } from './results.ts';
import { requireLiveConfig, runScenarios, skippedResult } from './runner.ts';
import { Sandbox } from './sandbox.ts';
import { loadScenarios, selectScenarios } from './spec.ts';
import { actionShaUnderTest, requiredActionSha, scheduleTick } from './steps.ts';
import { sweep } from './sweeper.ts';
import { parseUiAnswers, renderUiChecklist } from './ui-checklist.ts';
import { OwnershipLedger, ownedRuns } from './ownership.ts';
import { loadHeldRun } from './held-run.ts';
import { recordUiResult, reportDirOf, reportEntry, takeUpHeldRun } from './ui-result.ts';
import { readTemplate, renderScheduler, SCHEDULER_FILE, WORKFLOW_FILES } from './workflow-files.ts';
import { walkthrough } from './walkthrough.ts';
import { dispatchCheck } from './dispatch-check.ts';

const list = (value: string | undefined) => (value === undefined ? undefined : value.split(',').map((item) => item.trim()).filter(Boolean));

async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'walkthrough') return walkthrough(argv.slice(1));
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ids: { type: 'string' },
      levels: { type: 'string' },
      slices: { type: 'string' },
      modes: { type: 'string' },
      teams: { type: 'string' },
      'writer-stopped': { type: 'boolean' },
      workers: { type: 'string', default: '4' },
      out: { type: 'string' },
      'status-page': { type: 'string' },
      'evidence-dir': { type: 'string' },
      defer: { type: 'string' },
      install: { type: 'boolean' },
      'keep-run': { type: 'boolean' },
    },
  });
  const command = positionals[0] ?? 'help';
  const log = (line: string) => process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${line}\n`);
  const all = loadScenarios();
  const selection = { ids: list(values.ids), levels: list(values.levels), slices: list(values.slices), modes: list(values.modes) };
  const teams = list(values.teams);
  const cleanSelection = Object.fromEntries(Object.entries(selection).filter(([, value]) => value !== undefined));
  const scenarios = selectScenarios(all, cleanSelection);
  if (teams !== undefined && scenarios.some((scenario) => scenario.slice === 'full')) throw new Error('full slices cannot select teams');
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

  if (command === 'scheduler') {
    const text = renderScheduler(readTemplate(WORKFLOW_FILES.sync), requiredActionSha());
    if (values.install !== true) {
      process.stdout.write(text);
      return 0;
    }
    requireLiveConfig(config);
    const rest = new SandboxRest(config, (await githubToken(config, 'actions')).token);
    const path = `.github/workflows/${SCHEDULER_FILE}`;
    if ((await rest.fileText(path)) === text) {
      log(`${path} on the default branch is already this rendering`);
      return 0;
    }
    const { commit } = await rest.putFile(path, text, 'Install the scheduled sync workflow');
    log(`installed ${path} on the default branch in ${commit}`);
    return 0;
  }

  if (command === 'dispatch-check') {
    try {
      const report = await dispatchCheck({ config, stateDir, keepRun: values['keep-run'] === true, log });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.ok ? 0 : 1;
    } catch (error) {
      // Not run: nothing was dispatched, which says nothing about the page.
      if (!(error instanceof EnvBlockedError)) throw error;
      process.stdout.write(`${JSON.stringify({ result: 'env-blocked', reason: error.message }, null, 2)}\n`);
      return 3;
    }
  }

  // Long runs renew harness app tokens before expiry and revoke every minted token.
  let shared: SharedAdmission | undefined;
  const sharedAdmission = async () => {
    if (shared === undefined) {
      shared = new SharedAdmission(new GitStateStore({ stateDir, url: config.gitUrl, env: refreshingGitEnv(async () => {
        const token = await githubToken(config, 'local');
        return new Sandbox({ url: config.gitUrl, token: token.token, stateDir, runId: 'control' }).env();
      }), log }));
    }
    return shared;
  };
  const appClients = new Map<string, LinearClient>();
  const tokens: Array<{ token: RunToken; hooks: LinearHooks }> = [];
  const harnessRunId = `${new Date().toISOString().slice(0, 10)}-${newRunId()}`;
  const hooksFor = (app: string) => ({
    beforeRequest: countAppRequest,
    log: (entry: LogEntry) => { process.stderr.write(`${JSON.stringify({ harnessRunId, app, ...entry })}\n`); },
  });
  try {
    for (const app of (command === 'run' && scenarios.some((scenario) => scenario.setup.state !== 'offline')) || command === 'ui-result' ? config.linearApps : []) {
      const hooks = hooksFor(app.name);
      const token = await mintAppToken({ clientId: app.clientId, clientSecret: app.clientSecret }, { hooks });
      tokens.push({ token, hooks });
      let previous = token;
      const current = tokenLease(token, (value) => value.expiresIn * 1000, async () => {
        const next = await mintAppToken({ clientId: app.clientId, clientSecret: app.clientSecret }, { hooks });
        tokens.push({ token: next, hooks });
        // Keep the previous token tracked until its revocation is confirmed.
        await revokeToken(previous.accessToken, { hooks, auth: previous.context });
        tokens.splice(tokens.findIndex((entry) => entry.token === previous), 1);
        previous = next;
        return next;
      });
      appClients.set(app.name, new LinearClient({ token: async () => (await current()).accessToken, auth: token.context, hooks }));
    }

    if (command === 'sweep' || command === 'recover') {
      requireLiveConfig(config);
      const recoveryId = command === 'recover' ? positionals[1] : undefined;
      if (command === 'recover' && (recoveryId === undefined || !RUN_ID_PATTERN.test(recoveryId) || values['writer-stopped'] !== true)) throw new Error('usage: recover <run id> --writer-stopped (verify the writer and all engine/workflow children stopped first)');
      if (recoveryId !== undefined && !ownedRuns(stateDir).includes(recoveryId)) throw new Error('recovery needs the owning run state directory and its ownership record');
      const recoveryLock = recoveryId === undefined ? undefined : await acquireLock(`ui-result-${recoveryId}`, { stateDir, runId: recoveryId, timeoutMs: 0 });
      let maintenance: { runId: string; owner: string; registration: ReturnType<typeof registerRun>; admission: SharedAdmission } | undefined;
      try {
        if (recoveryId !== undefined) requireStoppedLocalRun(stateDir, recoveryId);
        const token = await githubToken(config, 'local');
        const world = new LinearWorld(editorClient(config.editors['editor-a']));
        const teams = await world.teams();
        const admission = await sharedAdmission();
        if (recoveryId === undefined) {
          const runId = newRunId(); const owner = randomUUID();
          const registration = registerRun(stateDir, runId);
          new OwnershipLedger(stateDir, runId).scope([]);
          const result = await admission.reserve({ runId, owner, app: 'maintenance', full: true,
            need: { requests: 0, complexity: 0 }, reserve: { requests: 0, complexity: 0 }, maxWorkers: 1,
            readBudget: async () => budgetFromStatus(await world.client.rateLimitStatus(), Date.now()),
          });
          if (!result.admitted) { registration.done(); throw new Error('sweep requires exclusive admission; live reservations are still held'); }
          maintenance = { runId, owner, registration, admission };
        }
        const entry = recoveryId === undefined ? undefined : (await admission.store.read()).runs.find((run) => run.runId === recoveryId);
        if (recoveryId !== undefined && entry === undefined) throw new Error('run has no shared reservation; use ordinary sweep');
        const trash: Record<string, { before: number; after?: number }> = {};
        for (const zone of entry?.zones ?? []) trash[zone] = { before: await world.trashedInZone(zone) };
        // Explicit operator confirmation is required; time alone cannot prove
        // a writer stopped. Rotation fences old saved UI continuations.
        const recoveryOwner = entry === undefined ? undefined : await admission.beginRecovery(entry.runId, entry.owner, () => requireStoppedLocalRun(stateDir, entry.runId));
        const report = await sweep(
          {
            sandbox: new Sandbox({ url: config.gitUrl, token: token.token, stateDir, runId: 'sweep0' }),
            rest: new SandboxRest(config, token.token), world, teamIds: teams.map((team) => team.id), shared: admission,
            ...(recoveryId === undefined ? {} : { recovering: recoveryId }),
          }, stateDir,
        );
        for (const [zone, counts] of Object.entries(trash)) {
          try {
            counts.after = await world.trashedInZone(zone);
            if (counts.after > counts.before) report.errors.push('recovery increased a zone trash count');
          } catch { report.errors.push('recovery trash after-count unavailable'); }
        }
        if (report.errors.length === 0 && recoveryId !== undefined && recoveryOwner !== undefined) {
          await admission.release(recoveryId, recoveryOwner);
          forgetRun(stateDir, recoveryId);
        }
        process.stdout.write(`${JSON.stringify({ ...report, trash }, null, 2)}\n`);
        return report.errors.length === 0 ? 0 : 1;
      } finally {
        try {
          // Maintenance owns no scenario data; a completed sweep may leave
          // failed legacy cleanup for the next exclusive attempt. A crash
          // retains this grant and its local record for verified recovery.
          if (maintenance !== undefined) {
            await maintenance.admission.release(maintenance.runId, maintenance.owner);
            maintenance.registration.done();
          }
        } finally { recoveryLock?.release(); }
      }
    }

    if (command === 'run') {
      // Settings read only deep in a step are checked before anything runs.
      actionShaUnderTest();
      scheduleTick();
      const outDir = values.out ?? join(REPO_ROOT, 'test/e2e/out', harnessRunId);
      const deferred = new Set(list(values.defer) ?? []);
      const apps: App[] = (scenarios.some((scenario) => scenario.setup.state !== 'offline') ? config.linearApps : []).map((app) => ({
        name: app.name,
        key: createHash('sha256').update(app.clientId).digest('hex'),
        readBudget: async () => budgetFromStatus(await (appClients.get(app.name) as LinearClient).rateLimitStatus(), Date.now()),
      }));
      // Validate app authentication before shared Git access can hide its
      // safe request diagnostics behind an unrelated Git prerequisite error.
      if (scenarios.some((scenario) => !deferred.has(scenario.id) && scenario.setup.state !== 'offline')) for (const app of apps) await app.readBudget();
      const governor = apps.length === 0 ? null : new Governor({ apps, stateDir, log, shared: await sharedAdmission() });
      const startedAt = new Date().toISOString();
      log(`run ${harnessRunId}: ${scenarios.length} scenarios, ${values.workers} workers, output ${outDir}`);
      // SIGINT or SIGTERM: running scenarios finish with their cleanup, the rest are skipped.
      const stop = { requested: false };
      const onSignal = (signal: string) => {
        if (stop.requested) {
          log(`${signal} again: stopping now; shared reservations stay held for verified recovery`);
          process.exit(130);
        }
        stop.requested = true;
        log(`${signal}: finishing the running scenarios, skipping the rest`);
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      // --defer: selected scenarios reported skipped (for example to keep a heavy one for a quiet budget window).
      const ran = await runScenarios(scenarios.filter((s) => !deferred.has(s.id)), { config, governor, appClients, stateDir, outDir, ...(teams === undefined ? {} : { teams }), expectedRed: loadExpectedRed(), log }, workers, stop);
      const byId = new Map(ran.map((result) => [result.id, result]));
      const results = scenarios.map((s) => byId.get(s.id) ?? skippedResult(s, 'deferred to a later run'));
      const report: HarnessReport = { harnessRunId, startedAt, finishedAt: new Date().toISOString(), host: hostname(), selection: { ...cleanSelection, ...(teams === undefined ? {} : { teams }) }, results };
      const files = writeRunReport(report, outDir);
      log(`report: ${files.markdown}`);
      if (values['status-page'] !== undefined) updateStatusPage(values['status-page'], all.map((scenario) => scenario.id), report);
      if (values['evidence-dir'] !== undefined) log(`evidence: ${writeEvidence(report, values['evidence-dir'])}`);
      return gateExitCode(results, log);
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
        key: createHash('sha256').update(app.clientId).digest('hex'),
        readBudget: async () => budgetFromStatus(await (appClients.get(app.name) as LinearClient).rateLimitStatus(), Date.now()),
      }));
      if (config.linearApps.length > 0 && apps.length === 0) throw new Error(`the held run uses app ${held.appName}, which the test configuration does not have`);
      const governor = apps.length === 0 ? null : new Governor({ apps, stateDir, log, shared: await sharedAdmission() });
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
      return gateExitCode([result], log);
    }

    process.stdout.write('Usage: cli.ts run|plan|sweep|recover|checklist|ui-result|scheduler|dispatch-check|walkthrough [--ids ...] [--levels ...] [--slices ...] [--modes ...]\n');
    return command === 'help' ? 0 : 2;
  } finally {
    try { await shared?.store.close?.(); }
    catch { log('warning: local admission cache could not be removed'); }
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

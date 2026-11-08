// Step executors: one per `<kind>.<action>` of the spec schema.
//
// git steps commit as a person to the run's tracked branch; linear steps edit
// as editor-a or editor-b through their own API keys; run steps start the
// engine; fault steps arm the proxy or the engine's checkpoints; ui steps
// are left to the UI session's checklist. Every text a step writes is
// neutral work text with a run token, so I2 can find it on both sides.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS, type CommandName } from '../../../src/commands.ts';
import { readIds, stateRef, resolveStateConfig, type Git } from '../../../src/state/index.ts';
import { STOP_AFTER_ENV, type Checkpoint } from '../../../src/test-hooks.ts';
import { BANK_DIR, goldenMarkdownPath, loadBank, readOptional } from '../../probe/bank.ts';
import { runProbe } from '../../probe/probe.ts';
import { findDrift } from '../../probe/record.ts';
import { isCheckpoint } from './checkpoints.ts';
import { newRunId } from './isolation.ts';
import { nextToken, type Editor, type RunContext } from './context.ts';
import { REPO_ROOT, engineEntry, runEngine, startEngine, type EngineCall, type EngineResult } from './engine.ts';
import { personCommit } from './sandbox.ts';
import { EnvBlockedError, HarnessGapError, NotImplementedError, ProductError } from './results.ts';
import type { Step } from './spec.ts';

export const ENGINE_TIMEOUT_MS = 30 * 60_000;
export const CHECKPOINT_TIMEOUT_MS = 10 * 60_000;
/** The workflow file the sync's setup writes into a repository (`init`). */
export const SYNC_WORKFLOW = 'mdbisync.yml';

type Executor = (ctx: RunContext, args: Record<string, unknown>) => Promise<void>;

// --- helpers -------------------------------------------------------------

function live(ctx: RunContext) {
  if (ctx.live === null) throw new Error('this step needs the sandbox and Linear, but the scenario runs offline');
  return ctx.live;
}

const GAPS = new Set<string>();
/** Actions the harness cannot perform yet; their scenarios fail as harness gaps once the engine reaches them. */
export const HARNESS_GAPS: ReadonlySet<string> = GAPS;

function gap(step: string): Executor {
  GAPS.add(step);
  return async () => {
    throw new HarnessGapError(step);
  };
}

/** Synced Markdown documents of the run's tree (not annotation READMEs), sorted. */
export function documentPaths(ctx: RunContext): string[] {
  const world = live(ctx);
  const synced = new Set(world.manifest.files.filter((file) => file.synced && file.kind === 'markdown' && file.class !== 'lint-error').map((file) => file.path));
  return [...world.tree.paths].filter(([, source]) => synced.has(source) && !/(^|\/)README\.md$/.test(source)).map(([target]) => target).sort();
}

/** The scenario's target document: a named path or path suffix, else the first document. */
export function targetPath(ctx: RunContext, target?: unknown, offset = 0): string {
  const paths = documentPaths(ctx);
  if (typeof target === 'string') {
    const found = paths.find((path) => path === target || path.endsWith(`/${target}`) || path.includes(target));
    if (found !== undefined) return found;
  }
  const path = paths[offset % Math.max(1, paths.length)];
  if (path === undefined) throw new EnvBlockedError('the slice has no synchronized document to edit');
  return path;
}

/** A path in the same folder as `path` (a file at the root stays at the root). */
export function sibling(path: string, name: string): string {
  const folder = path.split('/').slice(0, -1).join('/');
  return folder === '' ? name : `${folder}/${name}`;
}

/**
 * Where a move goes. Specs name destinations by role: `project/<rest>` and
 * `same-project/<rest>` stay in the source's project folder;
 * `other-team/other-project/<rest>` goes to a project folder of another team.
 */
export function resolveDestination(ctx: RunContext, source: string, destination: string): string {
  const world = live(ctx);
  const projectFolders = [...world.tree.rewritten.keys()].map((readme) => readme.replace(/\/?README\.md$/, '')).sort();
  const own = projectFolders.filter((folder) => source.startsWith(`${folder}/`)).sort((a, b) => b.length - a.length)[0];
  const top = (path: string) => path.split('/')[0];
  const match = /^(project|same-project|other-team\/other-project)\/(.+)$/.exec(destination);
  if (match === null) return destination;
  const rest = match[2] as string;
  if (match[1] === 'other-team/other-project') {
    const other = projectFolders.find((folder) => top(folder) !== top(source));
    if (other === undefined) throw new EnvBlockedError('the slice has no project of another team to move to');
    return `${other}/${rest}`;
  }
  return own === undefined ? sibling(source, rest) : `${own}/${rest}`;
}

function paragraph(token: string): string {
  return `The review moved to the next morning, note ${token}.`;
}

async function readWorking(git: Git, path: string): Promise<string> {
  return readFileSync(join(git.dir, path), 'utf8');
}

async function pull(git: Git, ctx: RunContext): Promise<void> {
  await git.run(['pull', '--quiet', '--no-rebase', '--no-edit', 'origin', ctx.names.trackedBranch]);
}

async function commitAsPerson(ctx: RunContext, changes: Map<string, string | Buffer | null>, message: string, bypassHook = false): Promise<void> {
  const git = await ctx.person();
  await pull(git, ctx);
  const commit = await personCommit(git, ctx.names, changes, message, { verify: !bypassHook });
  ctx.ownCommits.push(commit);
}

/** The Linear document id the engine recorded for a path, from the run's ids ref. */
export async function documentId(ctx: RunContext, path: string): Promise<string> {
  const git = await ctx.person();
  const config = resolveStateConfig({ trackedBranch: ctx.names.trackedBranch, syncBranch: ctx.names.syncBranch, refPrefix: ctx.names.refPrefix });
  const ref = stateRef(config, 'ids');
  try {
    await git.run(['fetch', '--quiet', 'origin', `+${ref}:${ref}`]);
  } catch {
    throw new ProductError(`no ${ref.split('/').pop()} state ref: the engine has not recorded any document`);
  }
  const ids = await readIds(git, (await git.text(['rev-parse', ref])).trim());
  const entry = ids.get(path);
  if (entry === undefined) throw new ProductError(`the engine recorded no document for a target path`);
  return entry.id;
}

async function editorEdit(ctx: RunContext, editor: Editor, path: string, change: (text: string, token: string) => string, removal = false): Promise<string> {
  const world = live(ctx);
  const id = await documentId(ctx, path);
  const client = world.editors[editor];
  const [document] = await client.getDocuments([id], { withContent: true });
  if (document === undefined) throw new ProductError('a recorded document does not exist in Linear');
  const token = nextToken(ctx);
  await client.updateDocument(id, { content: change(document.content ?? '', token) });
  ctx.edits.push({ side: 'linear', path, token, ...(removal ? { removal } : {}) });
  return token;
}

function editor(args: Record<string, unknown>): Editor {
  return args.actor === 'editor-b' ? 'editor-b' : 'editor-a';
}

// --- the engine ----------------------------------------------------------

async function engineCall(ctx: RunContext, command: CommandName, args: Record<string, unknown>): Promise<EngineCall> {
  const world = live(ctx);
  const index = ctx.engine.results.length + (ctx.engine.pending === undefined ? 0 : 1);
  const dir = join(ctx.runDir, `engine-${index}`);
  mkdirSync(dir, { recursive: true });
  const linear = ctx.engine.badCredential === 'linear' ? { linearClientId: world.engineApp.clientId, linearClientSecret: 'not-a-valid-secret' } : { linearClientId: world.engineApp.clientId, linearClientSecret: world.engineApp.clientSecret };
  return {
    command,
    names: ctx.names,
    ...(typeof args.direction === 'string' ? { direction: args.direction } : {}),
    ...(args.confirm === true ? { confirm: true } : {}),
    cwd: await ctx.engineClone(),
    repository: world.repository,
    extraEnv: { ...ctx.engine.env },
    hooksDir: ctx.checkpoints.dir,
    reportFile: join(dir, 'report.json'),
    summaryFile: join(dir, 'summary.md'),
    linearUrl: ctx.proxy?.url ?? 'https://api.linear.app',
    credentials: { ...linear, githubToken: ctx.engine.badCredential === 'github' ? 'not-a-valid-token' : world.githubToken },
    timeoutMs: ENGINE_TIMEOUT_MS,
  };
}

/** Records an engine result; a "not implemented" answer stops the scenario. */
function settleResult(ctx: RunContext, result: EngineResult): void {
  ctx.engine.results.push(result);
  const n = ctx.engine.results.length - 1 - ctx.engine.setupRuns;
  ctx.observations.set(`runs.${n}.exitCode`, result.exitCode);
  if (result.report !== null) for (const [key, value] of Object.entries(result.report)) ctx.observations.set(`runs.${n}.${key}`, value);
  if (result.notImplemented) throw new NotImplementedError(result.command, 'the engine command');
  if (result.timedOut) throw new ProductError(`${result.command} did not finish within ${ENGINE_TIMEOUT_MS / 60_000} minutes`);
}

async function runCommand(ctx: RunContext, command: CommandName, args: Record<string, unknown>): Promise<void> {
  if (ctx.live === null) {
    // Offline commands (lint, fix) run on the fixture bank and the corpus without credentials.
    const result = spawnSync(process.execPath, [engineEntry(), command], { encoding: 'utf8', cwd: ctx.runDir });
    if (result.status === COMMANDS[command].notImplementedExitCode && result.stderr.includes('not implemented')) throw new NotImplementedError(command);
    ctx.observations.set(`${command}.exitCode`, result.status);
    return;
  }
  const call = await engineCall(ctx, command, args);
  if (args.wait === false) {
    const running = startEngine(call);
    ctx.engine.pending = running;
    const reached = ctx.engine.pausedAt === undefined ? true : await ctx.checkpoints.waitReached(ctx.engine.pausedAt, { timeoutMs: CHECKPOINT_TIMEOUT_MS, exited: running.done });
    if (!reached) {
      running.kill();
      delete ctx.engine.pending;
      settleResult(ctx, await running.done);
      throw new ProductError(`the engine did not reach checkpoint ${ctx.engine.pausedAt}`);
    }
    return;
  }
  settleResult(ctx, await runEngine(call));
}

/** Runs the sync until a run changes nothing more (at most `limit` runs). */
async function settle(ctx: RunContext, limit = 4): Promise<void> {
  for (let attempt = 0; attempt < limit; attempt += 1) {
    await runCommand(ctx, 'sync', {});
    const last = ctx.engine.results.at(-1);
    if (last?.report?.['changed'] === false) return;
  }
}

// --- the executors -------------------------------------------------------

const RUN: Record<string, Executor> = {
  'run.sync': (ctx, args) => runCommand(ctx, 'sync', args),
  'run.initial-sync': (ctx, args) => runCommand(ctx, 'initial-sync', args),
  'run.settle': (ctx) => settle(ctx),
  'run.capture': (ctx) => runCommand(ctx, 'sync', {}),
  'run.lint': (ctx) => runCommand(ctx, 'lint', {}),
  'run.fix': (ctx) => runCommand(ctx, 'fix', {}),
  'run.resume-until-complete': async (ctx, args) => {
    // Recovery continues the sync unless the scenario names the initial sync (L1-16).
    const command = args.command === 'initial-sync' ? 'initial-sync' : 'sync';
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await runCommand(ctx, command, args);
      if (ctx.engine.results.at(-1)?.report?.['complete'] === true) return;
    }
    throw new ProductError('the run did not complete after 20 resumes');
  },
  'run.parallel': async (ctx, args) => {
    const count = typeof args.count === 'number' ? args.count : 2;
    // Each run gets its own checkout, as parallel workflow runs do.
    const world = live(ctx);
    const calls = [];
    for (let index = 0; index < count; index += 1) {
      const call = await engineCall(ctx, 'sync', {});
      const cwd = join(ctx.runDir, `engine-parallel-${index}`);
      if (!existsSync(cwd)) await world.sandbox.clone(ctx.names, cwd);
      calls.push({ ...call, cwd, reportFile: `${call.reportFile}.${index}`, summaryFile: `${call.summaryFile}.${index}` });
    }
    const results = await Promise.all(calls.map((call) => runEngine(call)));
    for (const result of results) settleResult(ctx, result);
  },
  'run.probe': async (ctx) => {
    // The format probe (a test tool, not the engine) writes the fixture bank to
    // Linear as the OAuth app and reads it back; it cleans up its own projects.
    const world = live(ctx);
    const bankDir = ctx.observations.get('probe.bankDir');
    const bank = loadBank(typeof bankDir === 'string' ? bankDir : undefined);
    const index = Number(ctx.observations.get('probe.runs') ?? 0);
    ctx.observations.set('probe.runs', index + 1);
    let run;
    try {
      // The probe's own run-id form, so the probe's sweeper finds a project a killed run left.
      const probeRunId = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${newRunId()}`;
      run = await runProbe({ client: world.app, bank, runId: probeRunId, facts: true, log: (line) => ctx.log(`probe: ${line}`) });
    } catch (error) {
      throw new EnvBlockedError(`format probe could not finish: ${(error as Error).message}`);
    }
    if (run.cleanup.some((line) => line.includes('NOT deleted'))) throw new EnvBlockedError('format probe left a project behind');
    const constructOf = new Map(run.fixtures.map((fixture) => [fixture.file, fixture.construct]));
    const drift = [...new Set(findDrift(bank, run).map((entry) => constructOf.get(entry.file) ?? entry.file))].sort();
    const probed = run.fixtures.filter((fixture) => fixture.refused === undefined && fixture.first !== undefined);
    const golden = new Map(probed.map((fixture) => [fixture.file, readOptional(join(bank.dir, goldenMarkdownPath(fixture.file))) ?? null]));
    ctx.observations.set('probe.firstReadback', new Map(probed.map((fixture) => [fixture.file, fixture.first])));
    ctx.observations.set('probe.secondReadback', new Map(probed.map((fixture) => [fixture.file, fixture.second])));
    ctx.observations.set('golden.linearForm', golden);
    ctx.observations.set('probe.drift', drift);
    ctx.observations.set(`runs.${index}.probe.drift`, drift);
  },
  'run.pre-commit': async (ctx) => {
    const scratch = join(ctx.runDir, 'scratch');
    if (!existsSync(scratch)) throw new Error('run.pre-commit needs git.scratch-hook first');
    const result = spawnSync('pre-commit', ['run', '--all-files'], { cwd: scratch, encoding: 'utf8' });
    if (result.error !== undefined) throw new EnvBlockedError('pre-commit is not installed on this host');
    const output = `${result.stdout}${result.stderr}`;
    if (output.includes('not implemented')) throw new NotImplementedError('fix', 'through the Linear-format hook');
    const n = Number(ctx.observations.get('preCommit.runs') ?? 0);
    ctx.observations.set('preCommit.runs', n + 1);
    ctx.observations.set(`hook.runs.${n}.exitCode`, result.status);
  },
  'run.scan-canaries': async () => {
    // The scan itself is a check (I5); this step marks where the scenario asks for it.
  },
  'run.cleanup': async () => {
    // Cleanup runs after every scenario; this step marks where L5-20 inspects it.
  },
  'run.workflow': async (ctx, args) => {
    const world = live(ctx);
    if (!(await world.rest.workflowExists(SYNC_WORKFLOW, ctx.names.trackedBranch))) {
      throw new NotImplementedError('init', `the sync workflow ${SYNC_WORKFLOW} is not in the tracked branch`);
    }
    if (world.githubTokenSource !== 'app') throw new EnvBlockedError('actions mode needs the GitHub App token');
    const inputs: Record<string, string> = {
      operation: typeof args.command === 'string' ? args.command : 'sync',
      'tracked-branch': ctx.names.trackedBranch,
      'sync-branch': ctx.names.syncBranch,
      'state-ref-prefix': ctx.names.refPrefix,
      ...(typeof args.direction === 'string' ? { direction: args.direction } : {}),
      ...(args.confirm === true ? { confirm: 'true' } : {}),
    };
    await world.rest.dispatchWorkflow(SYNC_WORKFLOW, ctx.names.trackedBranch, inputs);
    throw new HarnessGapError('run.workflow (waiting for the dispatched run)');
  },
  'run.workflow-parallel': gap('run.workflow-parallel'),
  'run.token-lifecycle': gap('run.token-lifecycle'),
  'run.burst': gap('run.burst'),
  'run.soak': gap('run.soak'),
};

const GIT: Record<string, Executor> = {
  'git.edit': async (ctx, args) => {
    const path = targetPath(ctx, args.target);
    const git = await ctx.person();
    await pull(git, ctx);
    const token = nextToken(ctx);
    const text = await readWorking(git, path);
    await commitAsPerson(ctx, new Map([[path, `${text.replace(/\n*$/, '\n')}\n${paragraph(token)}\n`]]), 'Update the review date');
    ctx.edits.push({ side: 'git', path, token });
  },
  'git.edit-many': async (ctx, args) => {
    const count = typeof args.documents === 'number' ? args.documents : 10;
    const git = await ctx.person();
    await pull(git, ctx);
    const changes = new Map<string, string>();
    for (const path of documentPaths(ctx).slice(0, count)) {
      const token = nextToken(ctx);
      changes.set(path, `${(await readWorking(git, path)).replace(/\n*$/, '\n')}\n${paragraph(token)}\n`);
      ctx.edits.push({ side: 'git', path, token });
    }
    await commitAsPerson(ctx, changes, 'Update review dates');
  },
  'git.add': async (ctx, args) => {
    const token = nextToken(ctx);
    const path = typeof args.path === 'string' ? args.path : sibling(targetPath(ctx), `notes-${token}.md`);
    await commitAsPerson(ctx, new Map([[path, `# Notes\n\n${paragraph(token)}\n`]]), 'Add notes', args.bypassHook === true);
    ctx.edits.push({ side: 'git', path, token });
  },
  'git.delete': async (ctx, args) => {
    const path = targetPath(ctx, args.target);
    await commitAsPerson(ctx, new Map([[path, null]]), 'Remove an old page');
    ctx.observations.set('git.deleted', path);
  },
  'git.move': async (ctx, args) => {
    const path = targetPath(ctx, args.target);
    const git = await ctx.person();
    await pull(git, ctx);
    const destination = typeof args.destination === 'string' ? resolveDestination(ctx, path, args.destination) : sibling(path, `moved-${nextToken(ctx)}.md`);
    mkdirSync(join(git.dir, destination.split('/').slice(0, -1).join('/')), { recursive: true });
    await git.run(['mv', path, destination]);
    await git.run(['commit', '--quiet', '-m', 'Move a page']);
    await git.run(['push', '--quiet', 'origin', `HEAD:refs/heads/${ctx.names.trackedBranch}`]);
    ctx.ownCommits.push((await git.text(['rev-parse', 'HEAD'])).trim());
    ctx.observations.set('git.moved', { from: path, to: destination });
  },
  'git.copy': async (ctx, args) => {
    const path = targetPath(ctx, args.target);
    const git = await ctx.person();
    await pull(git, ctx);
    const copy = path.replace(/\.md$/, `-copy-${nextToken(ctx)}.md`);
    await commitAsPerson(ctx, new Map([[copy, await readWorking(git, path)]]), 'Copy a page');
  },
  'git.front-matter': async (ctx, args) => {
    const path = targetPath(ctx, args.target);
    const git = await ctx.person();
    await pull(git, ctx);
    const text = await readWorking(git, path);
    const token = nextToken(ctx);
    const next = text.startsWith('---\n') ? text.replace(/^---\n/, `---\nreviewed: "${token}"\n`) : `---\nreviewed: "${token}"\n---\n${text}`;
    await commitAsPerson(ctx, new Map([[path, next]]), 'Mark the page reviewed');
  },
  'git.add-footnote': async (ctx, args) => {
    const path = targetPath(ctx, args.target);
    const git = await ctx.person();
    await pull(git, ctx);
    const text = await readWorking(git, path);
    await commitAsPerson(ctx, new Map([[path, `${text.replace(/\n*$/, '\n')}\nSee the note.[^1]\n\n[^1]: Added later.\n`]]), 'Add a footnote', args.bypassHook === true);
  },
  'git.delete-refs': async (ctx, args) => {
    const world = live(ctx);
    const stores = Array.isArray(args.names) ? (args.names as string[]) : ['linear', 'ids', 'uploads'];
    await world.sandbox.deleteRunRefs(ctx.names.runId, stores.map((store) => `${ctx.names.refPrefix}/${store}`));
  },
  'git.delete-sync-branch': async (ctx) => {
    await live(ctx).sandbox.deleteRunRefs(ctx.names.runId, [`refs/heads/${ctx.names.syncBranch}`]);
  },
  'git.close-pr': async (ctx) => {
    const world = live(ctx);
    const open = await world.rest.pullRequests(ctx.names.syncBranch, 'open');
    if (open.length === 0) throw new ProductError('no sync pull request is open');
    for (const pr of open) await world.rest.closePullRequest(pr.number);
  },
  'git.remove-security-hooks': async (ctx) => {
    const git = await ctx.person();
    await pull(git, ctx);
    const file = '.pre-commit-config.yaml';
    if (!existsSync(join(git.dir, file))) throw new EnvBlockedError('the slice has no .pre-commit-config.yaml');
    const text = await readWorking(git, file);
    await commitAsPerson(ctx, new Map([[file, text.replace(/^\s*alias:\s*security\s*$/gm, '')]]), 'Drop the hook alias', true);
  },
  'git.scratch-hook': async (ctx) => {
    // A scratch repository whose only hook is the published Linear-format hook, run from this checkout.
    const scratch = join(ctx.runDir, 'scratch');
    mkdirSync(scratch, { recursive: true });
    spawnSync('git', ['init', '--quiet', scratch]);
    writeFileSync(
      join(scratch, '.pre-commit-config.yaml'),
      `repos:\n  - repo: local\n    hooks:\n      - id: linear-format\n        name: Linear format\n        entry: node ${join(REPO_ROOT, 'src/cli.ts')} fix\n        language: system\n        files: \\.md$\n`,
    );
    writeFileSync(join(scratch, 'page.md'), '# Page\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n');
    spawnSync('git', ['add', '--all'], { cwd: scratch });
  },
  'git.open-pr': gap('git.open-pr'),
  'git.edit-sync-branch': gap('git.edit-sync-branch'),
  'git.image-add': gap('git.image-add'),
  'git.image-change': gap('git.image-change'),
  'git.move-folder': gap('git.move-folder'),
  'git.move-rewrite': gap('git.move-rewrite'),
  'git.annotation': gap('git.annotation'),
  'git.remove-footnote': gap('git.remove-footnote'),
  'git.resolve': gap('git.resolve'),
  'git.conflict-again': gap('git.conflict-again'),
  'git.ci-fix': gap('git.ci-fix'),
};

const LINEAR: Record<string, Executor> = {
  'linear.edit': async (ctx, args) => {
    await editorEdit(ctx, editor(args), targetPath(ctx, args.target), (text, token) => `${text.replace(/\n*$/, '\n')}\n${paragraph(token)}\n`);
  },
  'linear.edit-many': async (ctx, args) => {
    const count = typeof args.documents === 'number' ? args.documents : 10;
    for (const path of documentPaths(ctx).slice(0, count)) {
      await editorEdit(ctx, editor(args), path, (text, token) => `${text.replace(/\n*$/, '\n')}\n${paragraph(token)}\n`);
    }
  },
  'linear.repeated-edit': async (ctx, args) => {
    const count = typeof args.count === 'number' ? args.count : 5;
    const path = targetPath(ctx);
    for (let index = 0; index < count; index += 1) await editorEdit(ctx, editor(args), path, (text, token) => `${text.replace(/\n*$/, '\n')}\n${paragraph(token)}\n`);
  },
  'linear.rename': async (ctx, args) => {
    const world = live(ctx);
    const path = targetPath(ctx, args.target);
    const id = await documentId(ctx, path);
    const title = `${path.split('/').slice(0, -1).join('/')}/${String(args.title ?? 'renamed')}-${nextToken(ctx)}`.replace(/^\//, '');
    await world.editors[editor(args)].updateDocument(id, { title });
    ctx.observations.set('linear.renamed', { from: path, title });
  },
  'linear.trash': async (ctx, args) => {
    const world = live(ctx);
    const path = targetPath(ctx, args.target);
    await world.editors[editor(args)].trashDocument(await documentId(ctx, path));
    ctx.observations.set('linear.trashed', path);
  },
  'linear.restore': async (ctx, args) => {
    const world = live(ctx);
    const path = targetPath(ctx, args.target);
    await world.editors[editor(args)].restoreDocument(await documentId(ctx, path));
  },
  'linear.create': async (ctx, args) => {
    const world = live(ctx);
    const project = [...world.projects.values()][0];
    if (project === undefined) throw new EnvBlockedError('the slice maps no project');
    const token = nextToken(ctx);
    const title = typeof args.title === 'string' ? args.title : `guides/page-${token}`;
    const characters = typeof args.characters === 'number' ? args.characters : 0;
    const body = characters > 0 ? `${paragraph(token)}\n\n${'Plain text line. '.repeat(Math.ceil(characters / 17)).slice(0, characters)}\n` : `${paragraph(token)}\n`;
    await world.editors[editor(args)].createDocument({ projectId: project.id }, { title, content: body });
    ctx.edits.push({ side: 'linear', path: title, token });
  },
  'linear.move-project': gap('linear.move-project'),
  'linear.metadata': gap('linear.metadata'),
  'linear.out-of-scope': gap('linear.out-of-scope'),
  'linear.delete-permanently': gap('linear.delete-permanently'),
  'linear.image-add': gap('linear.image-add'),
  'linear.rich-edit': gap('linear.rich-edit'),
  'linear.resolve': gap('linear.resolve'),
  'linear.remove-one-marker': gap('linear.remove-one-marker'),
  'linear.edit-inside-markers': gap('linear.edit-inside-markers'),
  'linear.conflict-again': gap('linear.conflict-again'),
  'linear.remove-secret': gap('linear.remove-secret'),
};

function http(ctx: RunContext): NonNullable<RunContext['proxy']> {
  if (ctx.proxy === null) throw new Error('this fault needs the Linear proxy');
  return ctx.proxy;
}

const FAULT: Record<string, Executor> = {
  'fault.pause': async (ctx, args) => {
    if (!isCheckpoint(args.checkpoint)) throw new Error(`unknown checkpoint ${String(args.checkpoint)}`);
    ctx.checkpoints.pause(args.checkpoint);
    ctx.engine.pausedAt = args.checkpoint;
  },
  'fault.resume': async (ctx) => {
    const pending = ctx.engine.pending;
    if (ctx.engine.pausedAt !== undefined) ctx.checkpoints.resume(ctx.engine.pausedAt);
    delete ctx.engine.pausedAt;
    if (pending !== undefined) {
      delete ctx.engine.pending;
      settleResult(ctx, await pending.done);
    }
  },
  'fault.clear': async (ctx) => {
    ctx.proxy?.clearFaults();
    ctx.engine.env = {};
    delete ctx.engine.badCredential;
  },
  'fault.http': async (ctx, args) => {
    http(ctx).setFaults([{
      kind: 'http',
      status: Number(args.status),
      requestNumber: typeof args.requestNumber === 'number' ? args.requestNumber : 1,
      retryAfterSeconds: typeof args.retryAfterSeconds === 'number' ? args.retryAfterSeconds : null,
      times: typeof args.times === 'number' ? args.times : 1,
    }]);
  },
  'fault.write-error': async (ctx, args) => {
    const variants = Array.isArray(args.variants) ? (args.variants as string[]) : ['server-error'];
    http(ctx).setFaults(variants.map((variant) => ({ kind: 'write-error' as const, variant: variant === 'reset' ? 'reset' as const : 'server-error' as const, times: 1 })));
  },
  'fault.budget-headers': async (ctx, args) => {
    http(ctx).setFaults([{ kind: 'budget-headers', remaining: typeof args.remaining === 'number' ? args.remaining : 10, includeEndpointLimits: args.includeEndpointLimits === true }]);
  },
  'fault.reject-document': async (ctx, args) => {
    const path = targetPath(ctx, args.target);
    // The engine has not created the document yet: reject it by its title.
    http(ctx).setFaults([{ kind: 'reject-document', target: path.replace(/\.md$/, '').split('/').pop() as string }]);
  },
  'fault.upload-error': async (ctx) => {
    http(ctx).setFaults([{ kind: 'upload-error', times: 1 }]);
  },
  'fault.budget': async (ctx, args) => {
    ctx.engine.env[STOP_AFTER_ENV] = String(args.stopAfterDocuments ?? 80);
  },
  'fault.credentials': async (ctx, args) => {
    if (args.valid === true) delete ctx.engine.badCredential;
    else ctx.engine.badCredential = args.service === 'github' ? 'github' : 'linear';
  },
  'fault.permissions': async () => {
    throw new EnvBlockedError('needs a second GitHub App without a permission; agents do not create GitHub Apps');
  },
  'fault.merge-policy': async () => {
    throw new EnvBlockedError('needs the sandbox to refuse merge commits; agents do not change repository settings');
  },
  'fault.checks': async () => {
    throw new EnvBlockedError('needs a failing required check on the sync pull request; the GitHub App may only read checks');
  },
  'fault.stale-lease': gap('fault.stale-lease'),
  'fault.hooks': gap('fault.hooks'),
  'fault.annotation-target': gap('fault.annotation-target'),
  'fault.missing-lfs-object': gap('fault.missing-lfs-object'),
  'fault.golden-drift': async (ctx, args) => {
    // A recorded Linear form edited by hand, in a copy of the bank, so the next probe must report drift.
    const copy = join(ctx.runDir, 'bank');
    cpSync(BANK_DIR, copy, { recursive: true });
    const construct = String(args.construct ?? 'table');
    const fixture = loadBank(copy).fixtures.find((candidate) => candidate.construct.includes(construct) && existsSync(join(copy, goldenMarkdownPath(candidate.file))));
    if (fixture === undefined) throw new EnvBlockedError(`no recorded Linear form for a ${construct} fixture`);
    const golden = join(copy, goldenMarkdownPath(fixture.file));
    writeFileSync(golden, `${readFileSync(golden, 'utf8')}\nEdited by hand.\n`);
    ctx.observations.set('probe.bankDir', copy);
  },
};

const OTHER: Record<string, Executor> = {
  'kill.engine': async (ctx, args) => {
    const pending = ctx.engine.pending;
    if (pending === undefined || !isCheckpoint(args.checkpoint)) throw new Error('kill needs a paused asynchronous run');
    pending.kill();
    delete ctx.engine.pending;
    ctx.checkpoints.resume(args.checkpoint as Checkpoint);
    delete ctx.engine.pausedAt;
    const result = await pending.done;
    ctx.engine.results.push(result);
    ctx.observations.set(`runs.${ctx.engine.results.length - 1}.killed`, true);
  },
  'merge.pull-request': gap('merge.pull-request'),
};

const UI_ACTIONS = [
  'ui.assert-dom', 'ui.inspect-blocked', 'ui.inspect-conflict', 'ui.inspect-rendering', 'ui.paste-image',
  'ui.rename-trash-restore', 'ui.resolve-markers', 'ui.type-during-write', 'ui.type-two-editors', 'ui.verify-editor',
];

/** Every step action the schema knows, with its executor. UI steps are run by the UI session, not here. */
export const STEP_ACTIONS: Record<string, Executor> = {
  ...RUN,
  ...GIT,
  ...LINEAR,
  ...FAULT,
  ...OTHER,
  ...Object.fromEntries(UI_ACTIONS.map((action) => [action, async () => {
    throw new EnvBlockedError('UI steps run in the UI session from its checklist');
  }])),
};

export async function runStep(ctx: RunContext, step: Step): Promise<void> {
  const executor = STEP_ACTIONS[`${step.kind}.${step.action}`];
  if (executor === undefined) throw new HarnessGapError(`${step.kind}.${step.action}`);
  await executor(ctx, step.args);
}

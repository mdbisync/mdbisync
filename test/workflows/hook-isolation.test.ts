// The pre-commit template runs the pull request's own hooks, which are code
// anyone who can push to the branch controls. A step of a job can change the
// later steps of the same job: what it writes to `$GITHUB_ENV` (`BASH_ENV`,
// for one) and `$GITHUB_PATH` reaches each of them. So the hooks must never
// share a job with a step that holds a write token; that token belongs to a
// job of its own, which runs none of the pull request's code and takes the
// hooks job's fix only as data it checks.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

interface Step { name?: string; id?: string; uses?: string; with?: Record<string, unknown>; if?: string; env?: Record<string, string>; run?: string; shell?: string }
interface Job { name?: string; needs?: string | string[]; if?: string; permissions?: Record<string, string>; outputs?: Record<string, string>; steps: Step[] }
interface Workflow { permissions?: Record<string, string>; jobs: Record<string, Job> }

const TEMPLATE = new URL('../../examples/pre-commit.yml', import.meta.url);
const workflow = parse(await readFile(TEMPLATE, 'utf8')) as Workflow;

/** Whether a step runs the pull request's hooks. */
const runsHooks = (step: Step) => /\bpre-commit run\b/.test(step.run ?? '');
/** Whether a step is given a token or a secret. */
const holdsToken = (step: Step) => /github\.token|secrets\./.test(JSON.stringify(step));
/** Whether a job may write anything with its token. */
const writes = (job: Job) => Object.values(job.permissions ?? workflow.permissions ?? {}).some((access) => access !== 'read' && access !== 'none');

function bash(script: string, cwd: string, env: NodeJS.ProcessEnv) {
  // The runner's own command line for a `run` step.
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  assert.ifError(result.error);
  return result;
}

/** The variables a step of the same job gets from earlier steps' `$GITHUB_ENV` and `$GITHUB_PATH` writes, as the runner applies them. */
async function carried(files: { env: string; path: string }): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {};
  for (const line of (await readFile(files.env, 'utf8').catch(() => '')).split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1);
  }
  const paths = (await readFile(files.path, 'utf8').catch(() => '')).split('\n').filter(Boolean).reverse();
  if (paths.length > 0) env.PATH = [...paths, process.env.PATH].join(delimiter);
  return env;
}

describe('pre-commit template: hooks never run beside a write token', () => {
  it('a hook that changes the runner environment reaches no step that holds the token (harmless canary)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hook-isolation-'));
    try {
      const work = join(dir, 'work');
      await mkdir(work);
      assert.equal(spawnSync('git', ['init', '--quiet', work]).status, 0);
      const marker = join(dir, 'canary-fired');
      // The canary records only that it ran where a token was set, never the token.
      const canary = join(dir, 'canary.sh');
      await writeFile(canary, `[ -n "\${GH_TOKEN:-}" ] && echo "token step: $0" >> '${marker}'\ntrue\n`);
      const shims = join(dir, 'shims');
      await mkdir(shims);
      for (const tool of ['git', 'curl', 'node']) {
        await writeFile(join(shims, tool), `#!/bin/sh\n[ -n "\${GH_TOKEN:-}" ] && echo "token step: ${tool}" >> '${marker}'\nexit 0\n`);
        await chmod(join(shims, tool), 0o755);
      }
      // A hostile hook, in place of pre-commit: it persists BASH_ENV and a PATH entry for the later steps.
      const bin = join(dir, 'bin');
      await mkdir(bin);
      await writeFile(join(bin, 'pre-commit'), `#!/bin/sh\necho "BASH_ENV=${canary}" >> "$GITHUB_ENV"\necho "${shims}" >> "$GITHUB_PATH"\n`);
      await chmod(join(bin, 'pre-commit'), 0o755);

      let checked = 0;
      for (const [id, job] of Object.entries(workflow.jobs)) {
        const first = job.steps.findIndex(runsHooks);
        if (first < 0) continue;
        const files = { env: join(dir, `${id}.env`), path: join(dir, `${id}.path`) };
        const base: NodeJS.ProcessEnv = { PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: dir, RUNNER_TEMP: dir, GITHUB_ENV: files.env, GITHUB_PATH: files.path, GITHUB_OUTPUT: join(dir, 'output') };
        bash(job.steps[first]!.run!, work, base);
        assert.match(await readFile(files.env, 'utf8'), /BASH_ENV=/, 'the canary hook ran');
        checked += 1;
        // Every later step of the same job, whatever its condition, as the runner would start it.
        for (const step of job.steps.slice(first + 1)) {
          if (step.run === undefined || !holdsToken(step)) continue;
          const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, /github\.token|secrets\./.test(value) ? 'canary-not-a-token' : 'placeholder']));
          bash(step.run, work, { ...base, ...env, ...(await carried(files)) });
        }
      }
      assert.ok(checked > 0, 'no job runs the hooks');
      assert.equal(await readFile(marker, 'utf8').catch(() => ''), '', 'a hook reached a step that holds the token');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the jobs that run hooks can only read, and the job that writes runs no hook', () => {
    const hooks = Object.entries(workflow.jobs).filter(([, job]) => job.steps.some(runsHooks));
    assert.ok(hooks.length > 0);
    for (const [id, job] of hooks) {
      assert.deepEqual(job.permissions, { contents: 'read' }, `${id}: the hooks job's token`);
      for (const step of job.steps) assert.ok(!holdsToken(step), `${id}: ${step.name ?? step.uses}: a token beside the hooks`);
      // After the hooks, only shell steps and the upload of the fix, which the next job checks as data.
      for (const step of job.steps.slice(job.steps.findIndex(runsHooks))) {
        if (step.uses !== undefined) assert.match(step.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/, `${id}: ${step.uses} runs after the hooks`);
      }
    }
    // A cache the hooks job saves would reach the next job that restores it: no step caches.
    for (const step of Object.values(workflow.jobs).flatMap((job) => job.steps)) {
      assert.ok(!/^actions\/cache\b/.test(step.uses ?? ''), step.uses);
      if (step.uses?.startsWith('actions/setup-node@')) assert.equal(step.with?.['package-manager-cache'], false, 'setup-node caches');
    }
    for (const [id, job] of Object.entries(workflow.jobs).filter(([, each]) => writes(each))) {
      for (const step of job.steps) {
        // No command that runs hooks or the repository's own scripts, at a line's start or in a substitution.
        assert.ok(!/(?:^\s*|\$\(\s*)(?:pre-commit|python3?|npm|npx|make|bash|sh|\.{0,2}\/)(?:\s|$)/m.test(step.run ?? ''), `${id}: ${step.name}: runs pre-commit or the repository's scripts`);
        // Only actions that check out, set up Node or fetch the fix; none that runs the repository's code.
        if (step.uses !== undefined) assert.match(step.uses, /^actions\/(?:checkout|setup-node|download-artifact)@[0-9a-f]{40}$/, `${id}: ${step.uses}`);
        // Every git command there keeps the repository's hooks and monitors from running.
        for (const [, git] of (step.run ?? '').matchAll(/(?:^\s*|[$<]\(\s*)(git\b.*)$/gm)) {
          assert.match(git!, /^git -c core\.fsmonitor=false -c core\.hooksPath=\/dev\/null\b/, `${id}: ${step.name}`);
        }
      }
    }
  });
});

describe('pre-commit template: the publish job applies only a checked fix', () => {
  const apply = Object.values(workflow.jobs).flatMap((job) => job.steps).find((step) => step.name === 'Apply the checked fix')?.run;
  type Change = (git: (...args: string[]) => string, dir: string) => Promise<unknown>;

  /** A repository at the pull request's head, and the fix the hooks job would hand over, made by `change` in a copy. */
  async function setup(t: { after(fn: () => Promise<void>): void }, change: Change, message = 'Apply pre-commit fixes\n\nPre-commit-fix: stable-fix\n') {
    assert.ok(apply, 'the publish job has no apply step');
    const dir = await mkdtemp(join(tmpdir(), 'publish-fix-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const isolated = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const run = (cwd: string) => (...args: string[]) => {
      const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, env: isolated, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    const head = join(dir, 'head');
    await mkdir(head);
    const git = run(head);
    git('init', '--quiet');
    await writeFile(join(head, 'page.md'), '# Draft\n');
    await writeFile(join(head, 'tool.sh'), 'echo\n', { mode: 0o755 });
    await symlink('page.md', join(head, 'link.md'));
    git('add', '.');
    git('commit', '--quiet', '-m', 'Head');
    const hooks = join(dir, 'hooks');
    run(dir)('clone', '--quiet', head, hooks);
    const hooksGit = run(hooks);
    await change(hooksGit, hooks);
    hooksGit('add', '--all');
    hooksGit('commit', '--quiet', '--allow-empty', '-m', 'Fix');
    const temp = join(dir, 'temp');
    await mkdir(join(temp, 'pre-commit-fix'), { recursive: true });
    await writeFile(join(temp, 'pre-commit-fix', 'fix.patch'), hooksGit('diff', '--binary', 'HEAD^', 'HEAD'));
    await writeFile(join(temp, 'pre-commit-fix', 'message'), message);
    const result = () => {
      const outcome = bash(apply!, head, { ...isolated, RUNNER_TEMP: temp, GITHUB_OUTPUT: join(temp, 'output') });
      return { ...outcome, dirty: git('status', '--porcelain') };
    };
    return { temp, git, result };
  }

  it('commits a hook\'s change to a tracked file, with only the hook ids of its message', async (t) => {
    const message = 'Apply pre-commit fixes\n\nPre-commit-fix: stable-fix\nPre-commit-fix: $(touch owned)\nSigned-off-by: someone\nPre-commit-fix: aligned.table_2\nPre-commit-fix: mirrors/prettier+md\n';
    const { git, result, temp } = await setup(t, (_, dir) => writeFile(join(dir, 'page.md'), '# Ready\n'), message);
    const outcome = result();
    assert.equal(outcome.status, 0, outcome.stdout + outcome.stderr);
    assert.match(outcome.stdout, /::warning::/);
    assert.equal(git('show', '-s', '--format=%B', 'HEAD'), 'Apply pre-commit fixes\n\nPre-commit-fix: stable-fix\nPre-commit-fix: aligned.table_2\nPre-commit-fix: mirrors/prettier+md\n\n');
    assert.equal(git('show', 'HEAD:page.md'), '# Ready\n');
    assert.equal(git('show', '-s', '--format=%an <%ae>', 'HEAD').trim(), 'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>');
    assert.equal(outcome.dirty, '');
    assert.equal(await readFile(join(temp, 'output'), 'utf8'), `sha=${git('rev-parse', 'HEAD')}`);
  });

  const refused: Array<[string, Change, string?]> = [
    ['a new file', (_, dir) => writeFile(join(dir, 'new.md'), 'new\n')],
    ['a deleted file', (_, dir) => rm(join(dir, 'page.md'))],
    ['a changed symbolic link', async (_, dir) => { await rm(join(dir, 'link.md')); await symlink('/etc/hostname', join(dir, 'link.md')); }],
    ['a mode change', (_, dir) => chmod(join(dir, 'tool.sh'), 0o644)],
    ['a renamed file', async (git) => git('mv', 'page.md', 'moved.md')],
    ['another message', (_, dir) => writeFile(join(dir, 'page.md'), '# Ready\n'), 'Release everything\n'],
  ];
  for (const [what, change, message] of refused) {
    it(`refuses a fix with ${what} and changes nothing`, async (t) => {
      const { git, result } = await setup(t, change, message);
      const before = git('rev-parse', 'HEAD');
      const outcome = result();
      assert.notEqual(outcome.status, 0, what);
      assert.match(outcome.stdout, /::error::The pre-commit fix is refused/);
      assert.equal(git('rev-parse', 'HEAD'), before);
      assert.equal(outcome.dirty, '');
    });
  }

  it('refuses a patch that states only a new mode, and commits nothing', async (t) => {
    const { git, result, temp } = await setup(t, (_, dir) => writeFile(join(dir, 'page.md'), '# Ready\n'));
    // Hand-made: a mode line without the old one, which a summary of the patch may not show.
    await writeFile(join(temp, 'pre-commit-fix', 'fix.patch'), 'diff --git a/page.md b/page.md\nnew mode 100755\n--- a/page.md\n+++ b/page.md\n@@ -1 +1 @@\n-# Draft\n+# Ready\n');
    const before = git('rev-parse', 'HEAD');
    const outcome = result();
    assert.notEqual(outcome.status, 0, outcome.stdout + outcome.stderr);
    assert.match(outcome.stdout, /::error::The pre-commit fix is refused/);
    assert.equal(git('rev-parse', 'HEAD'), before);
  });

  it('refuses a fix whose files are links, and changes nothing', async (t) => {
    const { git, result, temp } = await setup(t, (_, dir) => writeFile(join(dir, 'page.md'), '# Ready\n'));
    await rm(join(temp, 'pre-commit-fix', 'message'));
    await symlink('/etc/hostname', join(temp, 'pre-commit-fix', 'message'));
    const before = git('rev-parse', 'HEAD');
    const outcome = result();
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stdout, /::error::The pre-commit fix is refused/);
    assert.equal(git('rev-parse', 'HEAD'), before);
  });
});

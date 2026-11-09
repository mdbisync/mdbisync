// Contract tests on the workflow templates a deployer copies from
// `examples/`: every action pinned by commit, the shared concurrency group,
// the GitHub App token, a checkout that keeps no credentials, the Linear
// secrets given to the action's steps only, and the security hooks in a
// step of their own that holds none of them.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const EXAMPLES = new URL('../../examples/', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, EXAMPLES), 'utf8');

const APP_TOKEN = 'actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510';
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const ACTION = 'mdbisync/mdbisync@';

/** The templates that run the action. */
const SYNC_TEMPLATES = ['mdbisync-initial-sync.yml', 'mdbisync.yml'];

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: unknown;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, { steps: Step[]; permissions?: unknown }>;
}

const workflow = (file: string) => parse(read(file)) as Workflow;
const steps = (file: string) => Object.values(workflow(file).jobs).flatMap((job) => job.steps);
/** The action's two steps around the hooks step: `stage`, then `apply`. */
const actionSteps = (file: string) => {
  const found = steps(file).filter((step) => step.uses?.startsWith(ACTION));
  assert.deepEqual(found.map((step) => step.with?.['security-step']), ['stage', 'apply'], `${file}: the stage and apply steps`);
  assert.equal(found[0]?.id, 'stage');
  return found as [Step, Step];
};
const hooksStep = (file: string) => {
  const found = steps(file).filter((step) => step.name === 'Run the security hooks');
  assert.equal(found.length, 1, `${file}: one hooks step`);
  return found[0] as Step;
};

describe('workflow templates', () => {
  it('every template in examples/ pins each action to a full commit with its version beside it', () => {
    const files = readdirSync(EXAMPLES).filter((file) => file.endsWith('.yml'));
    for (const name of SYNC_TEMPLATES) assert.ok(files.includes(name), `${name} is missing`);
    for (const file of files) {
      for (const line of read(file).split('\n')) {
        const uses = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
        if (uses === null) continue;
        assert.match(uses[1] as string, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${file}: ${line.trim()}`);
        assert.match(uses[2] as string, /^\s+# v\d+\.\d+\.\d+(?:-[\w.]+)?$/, `${file}: ${line.trim()} has no version comment`);
      }
    }
  });

  for (const file of SYNC_TEMPLATES) {
    describe(file, () => {
      it('grants the workflow token nothing and runs one at a time in the shared group, never cancelled', () => {
        const parsed = workflow(file);
        assert.deepEqual(parsed.permissions, {});
        for (const job of Object.values(parsed.jobs)) assert.equal(job.permissions, undefined);
        assert.deepEqual(parsed.concurrency, { group: 'mdbisync', 'cancel-in-progress': false });
      });

      it('mints the GitHub App token first and checks out without stored credentials', () => {
        const [token, checkout] = steps(file);
        assert.equal(token?.uses, APP_TOKEN);
        assert.equal(token?.id, 'app-token');
        assert.deepEqual(token?.with, { 'client-id': '${{ vars.MDBISYNC_APP_CLIENT_ID }}', 'private-key': '${{ secrets.MDBISYNC_APP_PRIVATE_KEY }}' });
        assert.equal(checkout?.uses, CHECKOUT);
        assert.equal(checkout?.with?.['persist-credentials'], false);
        assert.equal(checkout?.with?.['fetch-depth'], 0);
        // The workflow token has no permissions, so a private repository is read with the App's.
        assert.equal(checkout?.with?.['token'], '${{ steps.app-token.outputs.token }}');
      });

      it('stops before the App token expires', () => {
        for (const job of Object.values(workflow(file).jobs) as Array<{ 'timeout-minutes'?: number }>) {
          assert.ok(typeof job['timeout-minutes'] === 'number' && job['timeout-minutes'] < 60, `${file}: timeout-minutes`);
        }
      });

      it('gives the App token to checkout and mdbisync, and the Linear secrets to mdbisync only', () => {
        const actions = actionSteps(file);
        assert.equal(actions[0].with?.['cleanup-tokens'], true);
        assert.equal(actions[1].with?.['cleanup-tokens'], undefined);
        for (const action of actions) {
          assert.equal(action.with?.['github-token'], '${{ steps.app-token.outputs.token }}');
          assert.equal(action.with?.['linear-client-id'], '${{ secrets.MDBISYNC_LINEAR_CLIENT_ID }}');
          assert.equal(action.with?.['linear-client-secret'], '${{ secrets.MDBISYNC_LINEAR_CLIENT_SECRET }}');
          // The same inputs in both steps, so the apply step runs the operation the stage step staged.
          const { 'security-step': _stage, 'cleanup-tokens': _cleanup, ...same } = actions[0].with ?? {};
          const { 'security-step': _apply, 'cleanup-tokens': _otherCleanup, ...other } = action.with ?? {};
          assert.deepEqual(other, same);
        }
        for (const step of steps(file)) {
          if (step.uses?.startsWith(ACTION)) continue;
          const text = JSON.stringify(step);
          const label = step.name ?? step.uses ?? 'a step';
          assert.ok(!/secrets\.MDBISYNC_LINEAR/.test(text), `${file}: ${label} sees the Linear secrets`);
          if (step.uses !== CHECKOUT) assert.ok(!/steps\.app-token/.test(text), `${file}: ${label} sees the App token`);
        }
      });

      it('runs the security hooks between stage and apply, in a step that gets only the stage step\'s command', () => {
        const order = steps(file).map((step) => (step.uses?.startsWith(ACTION) ? step.with?.['security-step'] : step.name)).filter((name) => ['stage', 'Run the security hooks', 'apply'].includes(String(name)));
        assert.deepEqual(order, ['stage', 'Run the security hooks', 'apply'], `${file}: step order`);
        const hooks = hooksStep(file);
        assert.equal(hooks.uses, undefined);
        // Skipped only when the pinned release gives no command; the apply step then has no answers and pushes nothing unchecked.
        assert.equal((hooks as Step & { if?: string }).if, "steps.stage.outputs.hooks != ''");
        assert.equal(hooks.run, '"$MDBISYNC_NODE" "$MDBISYNC_HOOKS"');
        // Hook keys the deployer adds go into this env; the template adds none.
        assert.deepEqual(hooks.env, { MDBISYNC_NODE: '${{ steps.stage.outputs.node }}', MDBISYNC_HOOKS: '${{ steps.stage.outputs.hooks }}' });
        assert.ok(!/secrets\.|github\.token|steps\.app-token/.test(JSON.stringify(hooks)), `${file}: the hooks step sees a secret`);
      });

      it('installs a pinned pre-commit before mdbisync, for the security hooks on content from Linear', () => {
        const all = steps(file);
        const action = all.findIndex((step) => step.uses?.startsWith(ACTION));
        // A runner that brings its own pre-commit keeps it; otherwise the pinned version is installed.
        const install = all.findIndex((step) => /^command -v pre-commit \|\| pipx install pre-commit==\d+\.\d+\.\d+$/.test(step.run?.trim() ?? ''));
        assert.ok(install >= 0 && install < action, `${file}: pre-commit is not installed before the sync`);
        assert.equal(all[install]?.env, undefined, `${file}: the install step gets an environment`);
      });
    });
  }

  describe('mdbisync.yml', () => {
    const file = 'mdbisync.yml';

    it('runs on pushes to main, every five minutes and by hand', () => {
      const on = workflow(file).on;
      assert.deepEqual(Object.keys(on).sort(), ['push', 'schedule', 'workflow_dispatch']);
      assert.deepEqual(on['push'], { branches: ['main'] });
      assert.deepEqual(on['schedule'], [{ cron: '*/5 * * * *' }]);
      assert.equal(on['workflow_dispatch'], null);
    });

    it('runs the sync entry point', () => {
      for (const action of actionSteps(file)) {
        assert.equal(action.with?.['operation'], 'sync');
        assert.equal(action.with?.['direction'], undefined);
      }
    });
  });

  it('the sync and the initial sync share one concurrency group', () => {
    const groups = new Set(SYNC_TEMPLATES.map((file) => workflow(file).concurrency?.group));
    assert.deepEqual([...groups], ['mdbisync']);
  });

  describe('mdbisync-initial-sync.yml', () => {
    const file = 'mdbisync-initial-sync.yml';

    it('starts only by hand, with a direction that has no default and a confirm that defaults to a dry run', () => {
      const parsed = workflow(file);
      assert.deepEqual(Object.keys(parsed.on), ['workflow_dispatch']);
      const inputs = (parsed.on['workflow_dispatch'] as { inputs: Record<string, Record<string, unknown>> }).inputs;
      assert.deepEqual(Object.keys(inputs).sort(), ['confirm', 'direction']);
      assert.equal(inputs['direction']?.['required'], true);
      assert.equal(inputs['direction']?.['default'], undefined);
      assert.equal(inputs['confirm']?.['type'], 'boolean');
      assert.equal(inputs['confirm']?.['default'], false);
    });

    it('runs the initial sync entry point with the dispatch inputs', () => {
      for (const action of actionSteps(file)) {
        assert.equal(action.with?.['operation'], 'initial-sync');
        assert.equal(action.with?.['direction'], '${{ inputs.direction }}');
        assert.equal(action.with?.['confirm'], '${{ inputs.confirm }}');
      }
    });
  });
});

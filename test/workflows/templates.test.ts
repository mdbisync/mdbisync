// Contract tests on the workflow templates a deployer copies from
// `examples/`: every action pinned by commit, the shared concurrency group,
// the GitHub App token, a checkout that keeps no credentials, and the Linear
// secrets given to the sync's own step only.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const EXAMPLES = new URL('../../examples/', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, EXAMPLES), 'utf8');

const APP_TOKEN = 'actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510';
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const ACTION = 'mikhail-yaskou/mdbisync@';

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
const actionStep = (file: string) => {
  const found = steps(file).filter((step) => step.uses?.startsWith(ACTION));
  assert.equal(found.length, 1, `${file}: one mdbisync step`);
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
        const action = actionStep(file);
        assert.equal(action.with?.['github-token'], '${{ steps.app-token.outputs.token }}');
        assert.equal(action.with?.['linear-client-id'], '${{ secrets.MDBISYNC_LINEAR_CLIENT_ID }}');
        assert.equal(action.with?.['linear-client-secret'], '${{ secrets.MDBISYNC_LINEAR_CLIENT_SECRET }}');
        for (const step of steps(file)) {
          if (step.uses === action.uses) continue;
          const text = JSON.stringify(step);
          const label = step.name ?? step.uses ?? 'a step';
          assert.ok(!/secrets\.MDBISYNC_LINEAR/.test(text), `${file}: ${label} sees the Linear secrets`);
          if (step.uses !== CHECKOUT) assert.ok(!/steps\.app-token/.test(text), `${file}: ${label} sees the App token`);
        }
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
      const action = actionStep(file);
      assert.equal(action.with?.['operation'], 'sync');
      assert.equal(action.with?.['direction'], undefined);
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
      const action = actionStep(file);
      assert.equal(action.with?.['operation'], 'initial-sync');
      assert.equal(action.with?.['direction'], '${{ inputs.direction }}');
      assert.equal(action.with?.['confirm'], '${{ inputs.confirm }}');
    });
  });
});

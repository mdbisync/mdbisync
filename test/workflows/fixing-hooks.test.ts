import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { createFixture } from '../../src/state/test-helpers.ts';
import { nameFixingHooks } from '../../src/sync/fix-hooks.ts';

test('the example runs real fixing hooks and records only modifying ids on the fixing commit', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  await fixture.seed({
    '.pre-commit-config.yaml': `repos:
  - repo: local
    hooks:
      - id: stable-fix
        name: Stable text
        language: system
        entry: node fix.mjs
        files: ^stable[.]md$
      - id: aligned-table
        name: Aligned table
        language: system
        entry: node fix.mjs
        files: ^unstable[.]md$
      - id: passing-check
        name: Passing check
        language: system
        entry: node output.mjs
        verbose: true
        pass_filenames: false
`,
    'output.mjs': "console.log('- hook id: unconfigured-output'); console.log('- files were modified by this hook');\n",
    'fix.mjs': `import { readFileSync, writeFileSync } from 'node:fs';
for (const file of process.argv.slice(2)) writeFileSync(file, readFileSync(file, 'utf8').replace('Draft', 'Ready').replace('| -- |', '| :-- |'));
`,
    'stable.md': '# Draft\n',
    'unstable.md': '| Check |\n| -- |\n| Complete |\n',
  });
  const git = await fixture.clone('ci');
  await git.run(['checkout', '--quiet', 'main']);
  const temp = join(fixture.root, 'runner-temp');
  await mkdir(temp);
  const workflow = parse(await readFile(new URL('../../examples/pre-commit.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs['pre-commit'].steps as Array<{ name?: string; run?: string }>;
  const env = { ...process.env, RUNNER_TEMP: temp, PRE_COMMIT_HOME: join(temp, 'cache'), SAME_REPOSITORY: 'true', GITHUB_OUTPUT: join(temp, 'outputs') };
  const run = (name: string) => {
    const script = steps.find((step) => step.name === name)?.run;
    assert.ok(script);
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], { cwd: git.dir, env, encoding: 'utf8', timeout: 60_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  run('Run all hooks and collect fixes');
  run('Commit fixes or show the fork patch');
  const trailers = await git.text(['show', '-s', '--format=%(trailers:key=Pre-commit-fix,valueonly)', 'HEAD']);
  assert.deepEqual(trailers.trim().split('\n'), ['aligned-table', 'stable-fix'], await readFile(join(temp, 'pre-commit.log'), 'utf8'));
  assert.equal(await readFile(join(git.dir, 'stable.md'), 'utf8'), '# Ready\n');
  assert.match(await readFile(join(git.dir, 'unstable.md'), 'utf8'), /\| :-- \|/);
  run('Check the fixed tree in the same job');
  assert.equal(await git.text(['status', '--porcelain']), '');

  const files: Array<{ path: string; hooks?: string[] }> = [{ path: 'unstable.md' }];
  await nameFixingHooks(git, 'HEAD', files);
  assert.deepEqual(files[0]?.hooks, ['aligned-table', 'stable-fix']);
  // A later edit replaces attribution, including when the older fix is still in history.
  await writeFile(join(git.dir, 'unstable.md'), '# Reviewed\n');
  await git.run(['add', 'unstable.md']);
  await git.run(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'Review']);
  const reviewed: Array<{ path: string; hooks?: string[] }> = [{ path: 'unstable.md' }];
  await nameFixingHooks(git, 'HEAD', reviewed);
  assert.equal(reviewed[0]?.hooks, undefined);
});

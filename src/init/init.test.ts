import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { runCli } from '../cli.ts';
import { checkLinearFormatHook, readHookConfig, securityHooks } from '../setup/hooks.ts';
import { readAnnotation } from '../mapping/annotations.ts';

const sha = '1234567890abcdef1234567890abcdef12345678';
const flags = ['init', '--release-sha', sha, '--release-version', 'v1.2.3', '--folder', 'guides', '--team', 'Planning', '--project', 'Roadmap'];
async function fixture(t: import('node:test').TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'init-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, '.git'));
  return cwd;
}

test('init creates usable workflows, matching hook pins and folder annotations, without network calls', async (t) => {
  const cwd = await fixture(t);
  const result = await runCli(flags, { cwd, fetch: () => { throw new Error('no network'); } });
  assert.equal(result.exitCode, 0, result.stderr);
  for (const name of ['mdbisync.yml', 'mdbisync-initial-sync.yml', 'pre-commit.yml']) {
    const text = await readFile(join(cwd, '.github/workflows', name), 'utf8');
    const workflow = parse(text);
    assert.ok(workflow.jobs);
    if (name !== 'pre-commit.yml') {
      assert.equal(workflow.concurrency.group, 'mdbisync');
      assert.equal((text.match(new RegExp(`mdbisync/mdbisync@${sha} # v1.2.3`, 'g')) ?? []).length, 2);
    }
  }
  const config = await readFile(join(cwd, '.pre-commit-config.yaml'), 'utf8');
  assert.equal(parse(config).repos[0].rev, sha);
  assert.equal(checkLinearFormatHook(readHookConfig(config)).state, 'passed');
  assert.deepEqual(securityHooks(readHookConfig(config)), []);
  assert.deepEqual(readAnnotation('guides/README.md', await readFile(join(cwd, 'guides/README.md'), 'utf8')), {
    annotation: { folder: 'guides', readme: 'guides/README.md', team: 'Planning', project: 'Roadmap' },
  });
  assert.match(result.stdout, /MDBISYNC_LINEAR_CLIENT_SECRET/);
  assert.match(result.stdout, /merge commits/i);
  assert.match(result.stdout, /pre-commit install/);
  assert.match(result.stdout, /dry run/i);
  const before = await stat(join(cwd, 'guides/README.md'));
  assert.equal((await runCli(flags, { cwd })).exitCode, 0);
  assert.equal((await stat(join(cwd, 'guides/README.md'))).mtimeMs, before.mtimeMs);
});

test('init keeps README content and custom hooks, and adds optional pinned security examples', async (t) => {
  const cwd = await fixture(t);
  await mkdir(join(cwd, 'guides'));
  await writeFile(join(cwd, 'guides/README.md'), '---\ntitle: Guide # keep this comment\n---\n\n# Guide\n\nKeep these words.\n');
  await writeFile(join(cwd, '.pre-commit-config.yaml'), '# our hooks\nrepos:\n  - repo: local\n    hooks:\n      - id: custom\n        name: custom\n        language: system\n        entry: true\n');
  const args = [...flags, '--security-hooks'];
  const result = await runCli(args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  const readme = await readFile(join(cwd, 'guides/README.md'), 'utf8');
  assert.match(readme, /title: Guide # keep this comment/);
  assert.ok(readme.endsWith('---\n\n# Guide\n\nKeep these words.\n'));
  const config = await readFile(join(cwd, '.pre-commit-config.yaml'), 'utf8');
  assert.match(config, /# our hooks/);
  assert.match(config, /id: custom/);
  assert.equal(securityHooks(readHookConfig(config)).length, 2);
  assert.match(config, /gitleaks.*:v?8\.30\.1@sha256:[a-f0-9]{64}/);
  assert.match(config, /--redact/);
  assert.equal((await runCli(args, { cwd })).exitCode, 0);
  assert.equal(await readFile(join(cwd, '.pre-commit-config.yaml'), 'utf8'), config);
  assert.equal(await readFile(join(cwd, 'guides/README.md'), 'utf8'), readme);
});

test('init validates all requested changes before writing and refuses conflicts', async (t) => {
  for (const conflict of ['workflow', 'annotation', 'yaml']) {
    const cwd = await fixture(t);
    await mkdir(join(cwd, 'guides'));
    if (conflict === 'workflow') {
      await mkdir(join(cwd, '.github/workflows'), { recursive: true });
      await writeFile(join(cwd, '.github/workflows/mdbisync.yml'), 'custom workflow\n');
    } else if (conflict === 'annotation') {
      await writeFile(join(cwd, 'guides/README.md'), '---\nlinear-team: Different\n---\n');
    } else await writeFile(join(cwd, '.pre-commit-config.yaml'), 'repos: [broken');
    const result = await runCli(flags, { cwd });
    assert.equal(result.exitCode, 2);
    await assert.rejects(readFile(join(cwd, '.github/workflows/mdbisync-initial-sync.yml')), { code: 'ENOENT' });
  }
});

test('init rejects missing flags, unknown options, invalid pins and escaping paths without prompting', async (t) => {
  const cwd = await fixture(t);
  for (const args of [['init'], [...flags, '--unknown'], flags.map((v) => v === sha ? 'main' : v), flags.map((v) => v === 'guides' ? '../outside' : v)]) {
    assert.equal((await runCli(args, { cwd })).exitCode, 2);
  }
  const outside = await mkdtemp(join(tmpdir(), 'outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(cwd, 'guides'));
  assert.equal((await runCli(flags, { cwd })).exitCode, 2);
  await assert.rejects(readFile(join(outside, 'README.md')), { code: 'ENOENT' });
});

// Source execution and the release bundle must carry the same workflow assets.
test('embedded workflow assets match the reviewed examples', async () => {
  const { default: templates } = await import('./workflows.json', { with: { type: 'json' } });
  for (const [name, text] of Object.entries(templates)) {
    assert.equal(text, await readFile(new URL(`../../examples/${name}`, import.meta.url), 'utf8'));
  }
});

test('init prompts only through an explicit terminal prompt and accepts team-only folders', async (t) => {
  const cwd = await fixture(t);
  const { runInit } = await import('./command.ts');
  const answers = [sha, 'guides', 'Planning', '', 'no'];
  const result = await runInit([], { cwd, prompt: async () => answers.shift() ?? assert.fail('unexpected question') });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(answers.length, 0);
});

test('init rejects an orphan project or nested team before writing files', async (t) => {
  const cwd = await fixture(t);
  for (const folders of [
    ['--folder', 'guides', '--project', 'Roadmap'],
    ['--folder', 'guides', '--team', 'Planning', '--folder', 'guides/sub', '--team', 'Other'],
  ]) {
    const result = await runCli(['init', '--release-sha', sha, ...folders], { cwd });
    assert.equal(result.exitCode, 2);
    await assert.rejects(readFile(join(cwd, '.pre-commit-config.yaml')), { code: 'ENOENT' });
  }
});

test('the bundled CLI initializes a repository with no dependency installation', async (t) => {
  const { existsSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const entry = new URL('../../dist/cli.js', import.meta.url);
  if (!existsSync(entry)) {
    assert.notEqual(process.env['CI'], 'true', 'CI must build the bundle');
    t.skip('build first to check the release entry');
    return;
  }
  const cwd = await fixture(t);
  const result = spawnSync(process.execPath, [entry.pathname, ...flags], { cwd, encoding: 'utf8', input: '' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(join(cwd, '.pre-commit-config.yaml'), 'utf8'), new RegExp(sha));
  assert.match(result.stdout, /Remaining admin steps/);
});

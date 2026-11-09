// Init's files feed the actual setup check and dry-run planner against fake APIs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { runCli } from '../cli.ts';
import { readAnnotation } from '../mapping/annotations.ts';
import { createFixture } from '../state/test-helpers.ts';
import { fakeWorld, fakeFetch, GITHUB_API, LINEAR_API } from '../setup/test-helpers.ts';
import { buildCorpus } from '../../test/corpus/generate.ts';
import type { RunReport } from '../run/finish.ts';

const SHA = '1234567890abcdef1234567890abcdef12345678';
test('init output passes setup and L1-03 dry-run assertions on mini documents', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.cleanup());
  const corpus = buildCorpus(SHA);
  const paths = new Set(corpus.slices.mini);
  const files: Record<string, string | Buffer> = {};
  const args = ['init', '--release-sha', SHA, '--no-security-hooks'];
  const world = fakeWorld();
  world.linear.teams = [];
  world.linear.projects = [];
  const expected: string[] = [];
  for (const file of corpus.files.filter((file) => paths.has(file.path))) {
    if (file.kind === 'markdown' && file.synced) expected.push(file.path);
    if (file.kind !== 'markdown' && file.kind !== 'other') { files[file.path] = file.content; continue; }
    if (file.path.startsWith('.github/') || file.path === '.pre-commit-config.yaml') continue;
    const text = file.content.toString('utf8');
    const result = readAnnotation(file.path, text);
    if ('annotation' in result && result.annotation) {
      const { annotation } = result;
      args.push('--folder', annotation.folder);
      if (annotation.team) {
        args.push('--team', annotation.team);
        world.linear.teams.push({ id: `team-${annotation.team}`, key: annotation.team, name: annotation.team });
      }
      if (annotation.project) {
        args.push('--project', annotation.project);
        const team = annotation.team ?? (annotation.folder.startsWith('eng/') ? 'ENG' : 'DOCS');
        world.linear.projects.push({ id: `project-${annotation.project}`, name: annotation.project, teamIds: [`team-${team}`] });
      }
      files[file.path] = text.replace(/^linear-(team|project):[^\n]*\n/gm, '');
    } else files[file.path] = file.content;
  }
  await fixture.seed(files);
  const initialized = await runCli(args, { cwd: join(fixture.root, 'seed') });
  assert.equal(initialized.exitCode, 0, initialized.stderr);
  await fixture.seed({});
  const git = await fixture.clone('work');
  const refsBefore = await fixture.remote.text(['for-each-ref', '--format=%(refname) %(objectname)']);
  const reportFile = join(fixture.root, 'report.json');
  const env = {
    PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
    MDBISYNC_LINEAR_CLIENT_ID: 'client-id', MDBISYNC_LINEAR_CLIENT_SECRET: 'client-secret',
    MDBISYNC_LINEAR_API_URL: LINEAR_API, MDBISYNC_GITHUB_TOKEN: 'gh-token',
    MDBISYNC_GITHUB_API_URL: GITHUB_API, MDBISYNC_REPOSITORY: 'owner/repo',
    MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_REPORT_FILE: reportFile,
  };
  const result = await runCli(['initial-sync'], { cwd: git.dir, env, fetch: fakeFetch(world) });
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(await readFile(reportFile, 'utf8')) as RunReport;
  assert.equal(report.ok, true);
  assert.deepEqual(report.summary?.plan.create, expected.sort());
  assert.deepEqual(report.summary?.leftOut, []);
  assert.match(result.stdout, /## Setup check/);
  assert.match(result.stdout, /Nothing was written/);
  assert.deepEqual(world.writes, []);
  assert.equal(await fixture.remote.text(['for-each-ref', '--format=%(refname) %(objectname)']), refsBefore);
  for (const file of corpus.files.filter((file) => paths.has(file.path) && file.canary)) {
    assert.ok(!result.stdout.includes(file.canary!), 'summary must not contain document content');
  }
  assert.equal(world.minted, world.revoked);
});

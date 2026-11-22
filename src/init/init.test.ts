import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, mkdir, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { runCli } from '../cli.ts';
import { appCreationUrl } from '../setup/app.ts';
import { QUICKSTART_URL } from '../setup/fixes.ts';
import { checkLinearFormatHook, readHookConfig, securityHooks } from '../setup/hooks.ts';

const sha = '1234567890abcdef1234567890abcdef12345678';
const flags = ['init', '--release-sha', sha, '--release-version', 'v1.2.3'];
async function fixture(t: import('node:test').TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), 'init-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, '.git'));
  return cwd;
}

test('init creates usable workflows and matching hook pins, and leaves folder annotations to the person, without network calls', async (t) => {
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
  assert.match(config, /repos:\n\s+- repo:/, 'new hooks use block YAML');
  assert.deepEqual((await readdir(cwd)).sort(), ['.git', '.github', '.pre-commit-config.yaml'], 'init writes no README');
  assert.match(result.stdout, /README\.md front matter: linear-team names the Linear team, and linear-project a project/);
  assert.match(result.stdout, /A folder inside a team's folder takes that team and leaves out linear-team\./);
  assert.match(result.stdout, /MDBISYNC_LINEAR_CLIENT_SECRET/);
  assert.ok(result.stdout.includes(appCreationUrl()), 'init prints the link that creates the GitHub App');
  assert.ok(result.stdout.includes(`${QUICKSTART_URL}#github-app`), 'init links the GitHub App section');
  const steps = result.stdout.split('Remaining admin steps:\n')[1]?.trim().split('\n');
  assert.ok(steps);
  assert.match(steps[0] ?? '', /^1\. In Settings → Environments, create mdbisync/);
  assert.match(steps[1] ?? '', /^2\. Create a Linear OAuth app/);
  assert.match(steps[2] ?? '', /^3\. Create a GitHub App/);
  assert.deepEqual(steps.slice(3), [
    '4. Allow merge commits.',
    "5. Mark each folder to synchronize in its README.md front matter: linear-team names the Linear team, and linear-project a project for that folder's documents. A folder inside a team's folder takes that team and leaves out linear-team.",
    '6. Install Node.js 24.2 or later and pre-commit. Run pre-commit install --hook-type pre-commit --hook-type pre-push, then pre-commit run --all-files. If the hook rewrites files and fails, run it again. Security scanner examples also need Docker.',
    '7. If you track a branch other than main, set tracked-branch on the mdbisync action steps, update BRANCH in both sync workflows, and update the push trigger in mdbisync.yml. Commit the setup files except .github/workflows/mdbisync.yml and push them to the tracked branch or merge them through a pull request. Dispatch initial sync from the tracked branch with a direction and leave confirm unchecked for a dry run. Review its plan before confirming: the target side is overwritten.',
    '8. After initial sync finishes (for linear-to-git, merge its pull request with Create a merge commit), commit .github/workflows/mdbisync.yml and push it to the tracked branch or merge it through a pull request to start the first sync run. After that run, you can make pre-commit a required check. See ' + QUICKSTART_URL + '#two-layers-of-checks.',
  ]);
  const before = await stat(join(cwd, '.github/workflows/mdbisync.yml'));
  const again = await runCli(flags, { cwd });
  assert.equal(again.exitCode, 0, again.stderr);
  assert.match(again.stdout, /already initialized/);
  assert.equal((await stat(join(cwd, '.github/workflows/mdbisync.yml'))).mtimeMs, before.mtimeMs);
});

test('init keeps README annotations and custom hooks as they are, and adds optional pinned security examples', async (t) => {
  const cwd = await fixture(t);
  await mkdir(join(cwd, 'guides'));
  // Conflicting annotations are the setup check's to report; init neither reads nor changes them.
  const readmes = { 'guides/README.md': '---\nlinear-team: Planning # keep this comment\n---\n\n# Guide\n\nKeep these words.\n', 'guides/sub/README.md': '---\nlinear-team: Other\n---\n' };
  await mkdir(join(cwd, 'guides/sub'));
  for (const [path, text] of Object.entries(readmes)) await writeFile(join(cwd, path), text);
  await writeFile(join(cwd, '.pre-commit-config.yaml'), '# our hooks\nrepos:\n  - repo: local\n    hooks:\n      - id: custom\n        name: custom\n        language: system\n        entry: true\n');
  const args = [...flags, '--security-hooks'];
  const result = await runCli(args, { cwd });
  assert.equal(result.exitCode, 0, result.stderr);
  for (const [path, text] of Object.entries(readmes)) assert.equal(await readFile(join(cwd, path), 'utf8'), text, path);
  const config = await readFile(join(cwd, '.pre-commit-config.yaml'), 'utf8');
  assert.match(config, /# our hooks/);
  assert.match(config, /id: custom/);
  assert.equal(securityHooks(readHookConfig(config)).length, 2);
  assert.match(config, /gitleaks.*:v?8\.30\.1@sha256:[a-f0-9]{64}/);
  assert.match(config, /--redact/);
  // Document text comes from Linear, so an inline allow comment in it must not exempt a line.
  assert.match(config, / dir --redact --no-banner --ignore-gitleaks-allow \.\n/);
  assert.doesNotMatch(config, /[&*]a\d/, 'each example writes its own lists, without YAML anchors');
  assert.equal((await runCli(args, { cwd })).exitCode, 0);
  assert.equal(await readFile(join(cwd, '.pre-commit-config.yaml'), 'utf8'), config);
  for (const [path, text] of Object.entries(readmes)) assert.equal(await readFile(join(cwd, path), 'utf8'), text, path);
});

test('init validates all requested changes before writing and refuses conflicts', async (t) => {
  for (const conflict of ['workflow', 'yaml']) {
    const cwd = await fixture(t);
    if (conflict === 'workflow') {
      await mkdir(join(cwd, '.github/workflows'), { recursive: true });
      await writeFile(join(cwd, '.github/workflows/mdbisync.yml'), 'custom workflow\n');
    } else await writeFile(join(cwd, '.pre-commit-config.yaml'), 'repos: [broken');
    const result = await runCli(flags, { cwd });
    assert.equal(result.exitCode, 2);
    await assert.rejects(readFile(join(cwd, '.github/workflows/mdbisync-initial-sync.yml')), { code: 'ENOENT' });
  }
});

test('init rejects missing flags, unknown options, invalid pins and symlinked destinations without prompting', async (t) => {
  const cwd = await fixture(t);
  for (const args of [['init'], [...flags, '--unknown'], flags.map((v) => v === sha ? 'main' : v)]) {
    assert.equal((await runCli(args, { cwd })).exitCode, 2);
  }
  const outside = await mkdtemp(join(tmpdir(), 'outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(cwd, '.github'));
  assert.equal((await runCli(flags, { cwd })).exitCode, 2);
  assert.deepEqual(await readdir(outside), []);
});

test('init no longer takes folder, team or project options', async (t) => {
  const cwd = await fixture(t);
  for (const option of ['--folder', '--team', '--project']) {
    const result = await runCli([...flags, option, 'guides'], { cwd });
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.startsWith(`init: unknown option: ${option}\n`), result.stderr);
    assert.doesNotMatch(result.stderr, /--(?:folder|team|project) </, 'the usage no longer lists them');
  }
  assert.deepEqual(await readdir(cwd), ['.git']);
});

// Source execution and the release bundle must carry the same workflow assets.
test('embedded workflow assets match the reviewed examples', async () => {
  const { default: templates } = await import('./workflows.json', { with: { type: 'json' } });
  for (const [name, text] of Object.entries(templates)) {
    assert.equal(text, await readFile(new URL(`../../examples/${name}`, import.meta.url), 'utf8'));
  }
});

test('init refuses a release older than the templates pin and writes the pinned one as before', async (t) => {
  const { MINIMUM_RELEASE } = await import('./releases.ts');
  const minimum = MINIMUM_RELEASE.version.replaceAll('.', '\\.');
  const rc2 = '79db9969462ae7f1f00c88e95b311e61db3c455e';
  const cwd = await fixture(t);
  const refused = await runCli(['init', '--release-sha', rc2, '--release-version', 'v0.1.0-rc.2'], { cwd });
  assert.equal(refused.exitCode, 2);
  assert.match(refused.stderr, new RegExp(`^init: release v0\\.1\\.0-rc\\.2 is older than ${minimum}, the release these workflows are written for and checked against\\. Use ${minimum} or later\n`));
  await assert.rejects(readFile(join(cwd, '.github/workflows/mdbisync.yml')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(cwd, '.pre-commit-config.yaml')), { code: 'ENOENT' });

  const written = await runCli(['init', '--release-sha', MINIMUM_RELEASE.sha, '--release-version', MINIMUM_RELEASE.version, '--no-security-hooks'], { cwd });
  assert.equal(written.exitCode, 0, written.stderr);
  const { default: templates } = await import('./workflows.json', { with: { type: 'json' } });
  for (const [name, text] of Object.entries(templates)) assert.equal(await readFile(join(cwd, '.github/workflows', name), 'utf8'), text, name);
  assert.equal(parse(await readFile(join(cwd, '.pre-commit-config.yaml'), 'utf8')).repos[0].rev, MINIMUM_RELEASE.sha);
});

test('init refuses an older release named only by its version, and asks nothing after an older SHA', async (t) => {
  const cwd = await fixture(t);
  const byVersion = await runCli(['init', '--release-sha', sha, '--release-version', 'v0.1.0-rc.2'], { cwd });
  assert.equal(byVersion.exitCode, 2);
  assert.match(byVersion.stderr, /^init: release v0\.1\.0-rc\.2 is older than /);
  const { runInit } = await import('./command.ts');
  const questions: string[] = [];
  const guided = await runInit([], { cwd, prompt: async (question) => { questions.push(question); return '79db9969462ae7f1f00c88e95b311e61db3c455e'; } });
  assert.equal(guided.exitCode, 2);
  assert.match(guided.stderr, /^init: release v0\.1\.0-rc\.2 is older than /);
  assert.deepEqual(questions, ['Release commit SHA: ']);
  await assert.rejects(readFile(join(cwd, '.pre-commit-config.yaml')), { code: 'ENOENT' });
});

test('init --help names the oldest release it writes', async () => {
  const { MINIMUM_RELEASE } = await import('./releases.ts');
  const help = await runCli(['init', '--help']);
  assert.ok(help.stdout.includes(`The release must be ${MINIMUM_RELEASE.version} or later`), help.stdout);
});

test('init prompts only through an explicit terminal prompt, for the release and the two choices', async (t) => {
  const cwd = await fixture(t);
  const { runInit } = await import('./command.ts');
  const { LFS_ATTRIBUTES } = await import('./command.ts');
  const answers = [sha, 'no', 'yes'];
  const questions: string[] = [];
  const result = await runInit([], { cwd, prompt: async (question) => { questions.push(question); return answers.shift() ?? assert.fail('unexpected question'); } });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(answers.length, 0);
  assert.deepEqual(questions.slice(0, 2), ['Release commit SHA: ', 'Include security hook examples (requires Docker)? [y/N] ']);
  assert.equal(questions.at(-1), 'Store embedded images and files in Git LFS? [y/N] ');
  assert.equal(await readFile(join(cwd, '.gitattributes'), 'utf8'), `${LFS_ATTRIBUTES.join('\n')}\n`);
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
  assert.match(result.stdout, /create mdbisync.*only the tracked branch.*Leave required reviewers off/);
  assert.match(result.stdout, /If your plan lacks environments or you are moving existing repository secrets/);
  assert.match(result.stdout, /jobs still read repository secrets.*branch rule does not protect those secrets/);
  assert.match(result.stdout, /Set repository variable MDBISYNC_LINEAR_CLIENT_ID and add environment secret MDBISYNC_LINEAR_CLIENT_SECRET/);
  assert.match(result.stdout, /Set repository variable MDBISYNC_APP_CLIENT_ID and add environment secret MDBISYNC_APP_PRIVATE_KEY/);
});

test('complete flags do not prompt even when a terminal prompt is available', async (t) => {
  const cwd = await fixture(t);
  const { runInit } = await import('./command.ts');
  const result = await runInit([...flags.slice(1), '--no-security-hooks', '--lfs'], { cwd, prompt: async () => assert.fail('flags must run non-interactively') });
  assert.equal(result.exitCode, 0, result.stderr);
});

test('with the release given, a terminal is asked only the choices the flags left open', async (t) => {
  const { runInit } = await import('./command.ts');
  for (const [given, expected] of [
    [[], ['Include security hook examples (requires Docker)? [y/N] ', 'Store embedded images and files in Git LFS? [y/N] ']],
    [['--security-hooks'], ['Store embedded images and files in Git LFS? [y/N] ']],
    [['--no-lfs'], ['Include security hook examples (requires Docker)? [y/N] ']],
  ] as const) {
    const cwd = await fixture(t);
    const questions: string[] = [];
    const result = await runInit([...flags.slice(1), ...given], { cwd, prompt: async (question) => { questions.push(question); return 'yes'; } });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(questions, expected, given.join(' '));
  }
});

test('security opt-in refuses incompatible existing IDs and malformed hooks', async (t) => {
  for (const hook of ['null', '{ id: gitleaks, name: custom, language: system, entry: gitleaks }']) {
    const cwd = await fixture(t);
    const before = `repos:\n  - repo: local\n    hooks: [${hook}]\n`;
    await writeFile(join(cwd, '.pre-commit-config.yaml'), before);
    assert.equal((await runCli([...flags, '--security-hooks'], { cwd })).exitCode, 2);
    assert.equal(await readFile(join(cwd, '.pre-commit-config.yaml'), 'utf8'), before);
    await assert.rejects(readFile(join(cwd, '.github/workflows/mdbisync.yml')), { code: 'ENOENT' });
  }
});

test('init updates a scanner hook an earlier init generated, and still refuses a changed one', async (t) => {
  for (const args of [[...flags, '--security-hooks'], flags]) {
    const cwd = await fixture(t);
    assert.equal((await runCli([...flags, '--security-hooks'], { cwd })).exitCode, 0);
    const current = await readFile(join(cwd, '.pre-commit-config.yaml'), 'utf8');
    const earlier = `# our note\n${current.replace(' --ignore-gitleaks-allow .', ' .')}`;
    assert.notEqual(earlier, `# our note\n${current}`);
    await writeFile(join(cwd, '.pre-commit-config.yaml'), earlier);
    const result = await runCli(args, { cwd });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(await readFile(join(cwd, '.pre-commit-config.yaml'), 'utf8'), `# our note\n${current}`);
  }
  // An alias of the generated hook follows its anchor; a hook defined only outside `repos` is refused, not edited.
  const aliased = await fixture(t);
  assert.equal((await runCli([...flags, '--security-hooks'], { cwd: aliased })).exitCode, 0);
  const generated = await readFile(join(aliased, '.pre-commit-config.yaml'), 'utf8');
  const anchored = generated.replace('      - id: gitleaks', '      - &scanner\n        id: gitleaks') + '  - repo: local\n    hooks:\n      - *scanner\n';
  await writeFile(join(aliased, '.pre-commit-config.yaml'), anchored.replace(' --ignore-gitleaks-allow .', ' .'));
  assert.equal((await runCli(flags, { cwd: aliased })).exitCode, 0);
  assert.equal(await readFile(join(aliased, '.pre-commit-config.yaml'), 'utf8'), anchored);
  const scanner = /      - &scanner\n((?:        .*\n)+)/.exec(anchored)![1]!.replace(' --ignore-gitleaks-allow .', ' .').replace(/^        /gm, '  ');
  const outside = `x-scanner: &outside\n${scanner}repos:\n  - repo: local\n    hooks:\n      - *outside\n`;
  await writeFile(join(aliased, '.pre-commit-config.yaml'), outside);
  const refused = await runCli(flags, { cwd: aliased });
  assert.equal(refused.exitCode, 2);
  assert.match(refused.stderr, /existing gitleaks hook differs/);
  assert.equal(await readFile(join(aliased, '.pre-commit-config.yaml'), 'utf8'), outside);
  // An entry anchored for another hook to share is refused, so that hook's command stays as it is.
  const sharedEntry = generated.replace(' --ignore-gitleaks-allow .', ' .').replace(/entry: (\S+ dir --redact --no-banner \.)\n/, 'entry: &cmd $1\n') + '  - repo: local\n    hooks:\n      - { id: other-scan, name: Other, language: docker_image, entry: *cmd }\n';
  assert.match(sharedEntry, /&cmd/);
  await writeFile(join(aliased, '.pre-commit-config.yaml'), sharedEntry);
  assert.equal((await runCli(flags, { cwd: aliased })).exitCode, 2);
  assert.equal(await readFile(join(aliased, '.pre-commit-config.yaml'), 'utf8'), sharedEntry);
  // An entry init never generated is the repository's own: init does not rewrite it.
  const cwd = await fixture(t);
  assert.equal((await runCli([...flags, '--security-hooks'], { cwd })).exitCode, 0);
  const custom = (await readFile(join(cwd, '.pre-commit-config.yaml'), 'utf8')).replace(' --ignore-gitleaks-allow .', ' --verbose .');
  await writeFile(join(cwd, '.pre-commit-config.yaml'), custom);
  assert.equal((await runCli([...flags, '--security-hooks'], { cwd })).exitCode, 2);
  assert.equal((await runCli(flags, { cwd })).exitCode, 0);
  assert.equal(await readFile(join(cwd, '.pre-commit-config.yaml'), 'utf8'), custom);
});

test('init reports a regular file in a destination path as a usage error', async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, '.github'), 'Keep me.');
  assert.equal((await runCli(flags, { cwd })).exitCode, 2);
  assert.equal(await readFile(join(cwd, '.github'), 'utf8'), 'Keep me.');
});

test('init --lfs adds the extension and assets-folder lines once, keeping the attributes already there', async (t) => {
  const { LFS_ATTRIBUTES } = await import('./command.ts');
  assert.ok(LFS_ATTRIBUTES.includes('**/assets/** filter=lfs diff=lfs merge=lfs -text'));
  assert.ok(LFS_ATTRIBUTES.includes('*.png filter=lfs diff=lfs merge=lfs -text'));
  assert.ok(!LFS_ATTRIBUTES.some((line) => line.includes('.md')), 'Markdown never goes to LFS');

  const fresh = await fixture(t);
  const result = await runCli([...flags, '--lfs'], { cwd: fresh });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(await readFile(join(fresh, '.gitattributes'), 'utf8'), `${LFS_ATTRIBUTES.join('\n')}\n`);
  assert.match(result.stdout, /git lfs install/);

  const kept = await fixture(t);
  const own = '# ours\n*.psd binary\n*.png  filter=lfs diff=lfs merge=lfs -text\n**/assets/** filter=lfs diff=lfs merge=lfs -text';
  await writeFile(join(kept, '.gitattributes'), own);
  assert.equal((await runCli([...flags, '--lfs'], { cwd: kept })).exitCode, 0);
  const written = await readFile(join(kept, '.gitattributes'), 'utf8');
  const added = LFS_ATTRIBUTES.filter((line) => !line.startsWith('*.png ') && !line.startsWith('**/assets/**'));
  assert.equal(written, `${own}\n${added.join('\n')}\n`);
  assert.equal((await runCli([...flags, '--lfs'], { cwd: kept })).exitCode, 0);
  assert.equal(await readFile(join(kept, '.gitattributes'), 'utf8'), written, 'a second run adds nothing');

  for (const choice of [[], ['--no-lfs']]) {
    const none = await fixture(t);
    const quiet = await runCli([...flags, ...choice], { cwd: none });
    assert.equal(quiet.exitCode, 0, quiet.stderr);
    await assert.rejects(readFile(join(none, '.gitattributes')), { code: 'ENOENT' });
    assert.doesNotMatch(quiet.stdout, /git lfs install/);
  }
  const twice = await runCli([...flags, '--lfs', '--no-lfs'], { cwd: await fixture(t) });
  assert.equal(twice.exitCode, 2);
  assert.match(twice.stderr, /^init: choose Git LFS once/);
});

test('the lines init --lfs writes send every assets file and listed image to LFS, and Markdown nowhere', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { LFS_ATTRIBUTES } = await import('./command.ts');
  const cwd = await mkdtemp(join(tmpdir(), 'init-lfs-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
  await writeFile(join(cwd, '.gitattributes'), `${LFS_ATTRIBUTES.join('\n')}\n`);
  const paths = ['assets/a.bin', 'team/assets/0123.xyz', 'team/deep/assets/b.svg', 'team/chart.png', 'team/photo.jpeg', 'team/doc.md', 'team/notes.txt', 'README.md'];
  const result = spawnSync('git', ['check-attr', 'filter', '--', ...paths], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const filters = Object.fromEntries(result.stdout.trim().split('\n').map((line) => { const [path, , value] = line.split(': '); return [path, value]; }));
  assert.deepEqual(filters, {
    'assets/a.bin': 'lfs', 'team/assets/0123.xyz': 'lfs', 'team/deep/assets/b.svg': 'lfs', 'team/chart.png': 'lfs', 'team/photo.jpeg': 'lfs',
    'team/doc.md': 'unspecified', 'team/notes.txt': 'unspecified', 'README.md': 'unspecified',
  });
});

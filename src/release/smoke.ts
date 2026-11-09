import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { notImplementedMessage } from '../commands.ts';
import { validateAction, validateHooks } from './package.ts';

// Pages every release hook must handle: one that `fix` rewrites into the form
// Linear keeps (a setext heading and a dash list item, not just whitespace),
// and one only its author can change, because Linear drops footnotes.
const FIXABLE = 'Notes\n=====\n\n- first item\n';
const UNFIXABLE = 'A note[^1].\n\n[^1]: Linear drops footnotes.\n';

type Run = (command: string, args: string[], extra?: Record<string, string>, cwd?: string) =>
  { status: number | null; stdout: string; stderr: string };

/**
 * Runs one hook's entry the way pre-commit does, from the installed package,
 * on a fixable and an unfixable page. A release whose hook is a stub, refuses
 * Markdown in Linear's form or changes a page it cannot fix fails here, before
 * it is tagged.
 */
async function checkHookEntry(entry: string, bin: string, pages: string, run: Run): Promise<void> {
  const [name, command] = entry.split(' ') as [string, 'lint' | 'fix'];
  const page = join(pages, 'page.md');
  const hook = async (text: string, subcommand: 'lint' | 'fix' = command) => {
    await writeFile(page, text);
    const result = run(join(bin, name), [subcommand, 'page.md'], {}, pages);
    const output = result.stdout + result.stderr;
    assert.equal(output.includes(notImplementedMessage(subcommand)), false, `${name} ${subcommand} is a stub:\n${output}`);
    return { status: result.status, output, after: await readFile(page, 'utf8') };
  };
  // The form Linear keeps comes from the release's own `fix`, so the lint hook
  // is checked against what the fix hook writes.
  const fixed = await hook(FIXABLE, 'fix');
  assert.equal(fixed.status, 1, `${name} fix on a fixable page:\n${fixed.output}`);
  assert.match(fixed.output, /^page\.md: fixed$/m);
  assert.notEqual(fixed.after.trimEnd(), FIXABLE.trimEnd(), `${name} fix changed no more than whitespace`);
  if (command === 'lint') {
    const reported = await hook(FIXABLE);
    assert.equal(reported.status, 1, `${entry} on a fixable page:\n${reported.output}`);
    assert.match(reported.output, /^page\.md: not in Linear's form/m);
    assert.equal(reported.after, FIXABLE, `${entry} changed a page`);
  }
  const kept = await hook(fixed.after);
  assert.equal(kept.status, 0, `${entry} on a page in Linear's form:\n${kept.output}`);
  assert.equal(kept.after, fixed.after, `${entry} changed a page in Linear's form`);
  const refused = await hook(UNFIXABLE);
  assert.equal(refused.status, 1, `${entry} on an unfixable page:\n${refused.output}`);
  assert.match(refused.output, /^page\.md:1: footnote: /m);
  assert.equal(refused.after, UNFIXABLE, `${entry} changed a page it cannot fix`);
}

export async function smokeRelease(directory: string): Promise<void> {
  const root = resolve(directory);
  const manifest = JSON.parse(await readFile(join(root, 'release.json'), 'utf8')) as { version: string };
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'scripts']) {
    assert.equal(key in pkg, false, `Release package must omit ${key}`);
  }
  const bins = pkg.bin as Record<string, string>;
  assert.equal(typeof bins.mdbisync, 'string');
  const temporary = await mkdtemp(join(tmpdir(), 'release-smoke-'));
  const env = { PATH: process.env.PATH, HOME: temporary, npm_config_offline: 'true', npm_config_ignore_scripts: 'true' };
  const run: Run = (command, args, extra = {}, cwd = root) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...env, ...extra } });
    if (result.error) throw result.error;
    return result;
  };
  try {
    const action: unknown = parse(await readFile(join(root, 'action.yml'), 'utf8'));
    const hooks: unknown = parse(await readFile(join(root, '.pre-commit-hooks.yaml'), 'utf8'));
    const [main, post] = validateAction(action);
    validateHooks(hooks);
    const actionRun = run(process.execPath, [join(root, main!)], { INPUT_OPERATION: '__release_smoke__' });
    assert.equal(actionRun.status, 1);
    assert.match(actionRun.stdout + actionRun.stderr, /unknown operation:/);
    const cleanup = run(process.execPath, [join(root, post!)]);
    assert.equal(cleanup.status, 0, cleanup.stderr);
    const help = run(process.execPath, [join(root, bins.mdbisync!), '--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
    const version = run(process.execPath, [join(root, bins.mdbisync!), '--version']);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), manifest.version.slice(1));
    const pack = run('npm', ['pack', '--offline', '--ignore-scripts', '--json', '--cache', join(temporary, 'cache'), '--pack-destination', temporary]);
    assert.equal(pack.status, 0, pack.stderr);
    const packed = JSON.parse(pack.stdout) as { filename: string }[];
    assert.equal(packed.length, 1);
    // This mirrors pre-commit's one-time local package installation, offline.
    const install = run('npm', ['install', '--global', '--offline', '--ignore-scripts', '--cache', join(temporary, 'cache'), '--prefix', join(temporary, 'prefix'), join(temporary, packed[0]!.filename)]);
    assert.equal(install.status, 0, install.stderr);
    const hookCli = run(join(temporary, 'prefix/bin/mdbisync'), ['--help']);
    assert.equal(hookCli.status, 0, hookCli.stderr);
    assert.match(hookCli.stdout, /Usage:/);
    const pages = join(temporary, 'pages');
    await mkdir(pages);
    for (const hook of hooks as { entry: string }[]) {
      await checkHookEntry(hook.entry, join(temporary, 'prefix/bin'), pages, run);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [directory] = process.argv.slice(2);
  if (!directory) throw new Error('Usage: smoke.ts RELEASE_DIRECTORY');
  await smokeRelease(directory);
}

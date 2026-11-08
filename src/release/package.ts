import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a mapping');
  return value as Record<string, unknown>;
}

export function validateVersion(version: string): string {
  const number = '(?:0|[1-9][0-9]*)';
  const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
  if (!new RegExp(`^v${number}\\.${number}\\.${number}-${identifier}(?:\\.${identifier})*$`).test(version) || version.trim() !== version) {
    throw new Error('Expected a semantic pre-release tag such as v0.1.0-rc.1');
  }
  return version.slice(1);
}

function validateSha(sha: string): void {
  if (sha.length !== 40 || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected a full lowercase source SHA');
}

function bundlePath(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || !/^dist\/[a-zA-Z0-9_-]+\.(?:cjs|js)$/.test(value)) {
    throw new Error('Entry must point to a local JavaScript bundle in dist/');
  }
  return value;
}

export function validateAction(action: unknown): string[] {
  const runs = record(record(action).runs);
  if (runs.using !== 'node24' || 'steps' in runs || 'image' in runs) {
    throw new Error('Action must use node24 bundles without shell steps or install commands');
  }
  if (runs['post-if'] !== undefined && runs['post-if'] !== 'always()') {
    throw new Error('Action cleanup must run regardless of main outcome');
  }
  return [bundlePath(runs.main), bundlePath(runs.post)];
}

export function validateHooks(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) throw new Error('At least one Node hook is required');
  for (const item of value) {
    const hook = record(item);
    if (hook.language !== 'node' || typeof hook.entry !== 'string' ||
        !/^mdbisync (?:lint|fix)$/.test(hook.entry) ||
        (hook.additional_dependencies !== undefined &&
         (!Array.isArray(hook.additional_dependencies) || hook.additional_dependencies.length !== 0))) {
      throw new Error('Hooks must use the bundled CLI without additional dependencies');
    }
  }
}

export function releasePackage(source: unknown, version: string): Record<string, unknown> {
  const pkg = record(source);
  if (typeof pkg.name !== 'string' || !/^(?:@[a-z0-9_-]+\/)?[a-z0-9_-]+$/.test(pkg.name)) {
    throw new Error('Package name is required');
  }
  const bins = record(pkg.bin);
  if (typeof bins.mdbisync !== 'string' || Object.keys(bins).length !== 1) {
    throw new Error('Package must expose the mdbisync bundled executable');
  }
  return {
    name: pkg.name, version: validateVersion(version), private: true, type: 'module',
    engines: { node: '>=24.2' }, bin: { mdbisync: bundlePath(bins.mdbisync) },
  };
}

export async function stageRelease(options: {
  source: string; output: string; sourceSha: string; version: string; action: unknown; hooks: unknown;
}): Promise<void> {
  const { source, output, sourceSha, version, action } = options;
  validateSha(sourceSha);
  validateVersion(version);
  validateHooks(options.hooks);
  const pkg = releasePackage(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')), version);
  const cli = (pkg.bin as Record<string, string>).mdbisync!;
  const bundles = [...new Set([...validateAction(action), cli])].sort();
  const distFiles = await readdir(join(source, 'dist'));
  const notices = bundles.map((file) => `${file}.LEGAL.txt`).filter((file) => distFiles.includes(file.slice(5)));
  const files = ['action.yml', '.pre-commit-hooks.yaml', 'LICENSE', 'README.md', ...notices, ...bundles];
  // Refuse symlinks and empty bundles before creating any release output.
  for (const file of files) {
    const info = await lstat(join(source, file));
    if (!info.isFile() || (bundles.includes(file) && info.size === 0)) throw new Error(`Invalid release file: ${file}`);
  }
  await mkdir(output);
  for (const file of files) {
    await mkdir(dirname(join(output, file)), { recursive: true });
    await copyFile(join(source, file), join(output, file));
  }
  const hashes: Record<string, string> = {};
  for (const file of bundles) hashes[file] = createHash('sha256').update(await readFile(join(output, file))).digest('hex');
  await writeFile(join(output, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  await writeFile(join(output, 'release.json'), `${JSON.stringify({ version, source: sourceSha, bundles: hashes }, null, 2)}\n`);
}

export async function createReleaseCommit(options: {
  repository: string; directory: string; sourceSha: string; version: string;
}): Promise<string> {
  const { repository, directory, sourceSha, version } = options;
  validateSha(sourceSha);
  validateVersion(version);
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  git('rev-parse', '--verify', `${sourceSha}^{commit}`);
  const gitDir = git('rev-parse', '--absolute-git-dir');
  const temporary = await mkdtemp(join(tmpdir(), 'release-index-'));
  try {
    const run = (...args: string[]) => execFileSync('git', ['--git-dir', gitDir, '--work-tree', directory, ...args], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') },
    }).trim();
    run('add', '--all', '--force', '.');
    const tree = run('write-tree');
    return run('commit-tree', tree, '-p', sourceSha, '-m', `Release ${version}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

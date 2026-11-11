// A compatible npm for hook installation, scoped to one scenario run.
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EnvBlockedError } from './results.ts';

const exec = promisify(execFile);
export const HOOK_NPM_MINIMUM = '11.16.0';
export const HOOK_NPM_VERSION = '11.21.1';
const REQUIRED = `the repository's Node hooks need npm ${HOOK_NPM_MINIMUM} or newer`;

export function compatibleHookNpm(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) return false;
  const actual = match.slice(1).map(Number);
  const minimum = HOOK_NPM_MINIMUM.split('.').map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index] !== minimum[index]) return actual[index]! > minimum[index]!;
  }
  return true;
}

/** Both working clones are direct children of the scenario's output folder. */
export function repositoryNpmDir(cwd: string): string {
  return join(dirname(resolve(cwd)), 'hook-npm');
}

function withNpm(dir: string, env: Record<string, string>): Record<string, string> {
  return { ...env, PATH: `${join(resolve(dir), 'node_modules', '.bin')}${delimiter}${env.PATH ?? ''}` };
}

/** Reuses this run's npm for both installation and later hook commands. */
export function hookNpmEnv(dir: string, env: Record<string, string>): Record<string, string> {
  return existsSync(join(dir, 'ready')) && existsSync(join(dir, 'node_modules', '.bin', 'npm')) ? withNpm(dir, env) : env;
}

/** `env` must already be allowlisted: the bootstrap receives no harness secrets. */
export async function provisionHookNpm(
  dir: string,
  env: Record<string, string>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Record<string, string>> {
  dir = resolve(dir);
  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
  const execution = () => ({ env, timeout: Math.max(1, deadline - Date.now()), maxBuffer: 1024 * 1024,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const usable = async (candidate: Record<string, string>) => {
    try {
      const { stdout } = await exec('npm', ['--version'], { ...execution(), env: candidate });
      return compatibleHookNpm(stdout);
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      return false;
    }
  };
  const current = hookNpmEnv(dir, env);
  if (await usable(current)) return current;
  try {
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, 'ready'), { force: true });
    for (const name of ['package.json', 'package-lock.json']) {
      copyFileSync(fileURLToPath(new URL(`./hook-npm/${name}`, import.meta.url)), join(dir, name));
    }
    for (const name of ['user.config', 'global.config']) writeFileSync(join(dir, name), '');
    // A fresh prefix and cache keep the host and other runs untouched. Empty
    // configuration files exclude user/global registry credentials and scripts.
    await exec('npm', ['ci', '--prefix', dir, '--cache', join(dir, 'cache'), '--ignore-scripts', '--no-audit', '--no-fund',
      '--userconfig', join(dir, 'user.config'), '--globalconfig', join(dir, 'global.config'), '--registry', 'https://registry.npmjs.org/'], { ...execution(), cwd: dir });
    const provisioned = withNpm(dir, env);
    if (!(await usable(provisioned))) throw new Error('incompatible npm');
    writeFileSync(join(dir, 'ready'), HOOK_NPM_VERSION);
    return provisioned;
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    // Never include bootstrap output: it can contain local paths or proxy details.
    throw new EnvBlockedError(`${REQUIRED}; per-run npm provisioning failed`);
  }
}

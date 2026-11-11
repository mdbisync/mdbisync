// A compatible npm for hook installation, scoped to one scenario run.
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EnvBlockedError } from './results.ts';

const exec = promisify(execFile);
export const HOOK_NPM_VERSION = '11.16.0';
const REQUIRED = `the repository's Node hooks need npm ${HOOK_NPM_VERSION} or newer`;

export function compatibleHookNpm(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) return false;
  const [major, minor] = match.slice(1).map(Number) as [number, number, number];
  return major > 11 || (major === 11 && minor >= 16);
}

/** Reuses this run's npm for both installation and later hook commands. */
export function hookNpmEnv(dir: string, env: Record<string, string>): Record<string, string> {
  const bin = join(dir, 'node_modules', '.bin');
  return existsSync(join(bin, 'npm')) ? { ...env, PATH: `${bin}${delimiter}${env.PATH ?? ''}` } : env;
}

/** `env` must already be allowlisted: the bootstrap receives no harness secrets. */
export async function provisionHookNpm(
  dir: string,
  env: Record<string, string>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Record<string, string>> {
  const execution = { env, timeout: options.timeoutMs ?? 5 * 60_000, maxBuffer: 1024 * 1024, ...options };
  const usable = async (candidate: Record<string, string>) => {
    try {
      const { stdout } = await exec('npm', ['--version'], { ...execution, env: candidate });
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
    for (const name of ['package.json', 'package-lock.json']) {
      copyFileSync(fileURLToPath(new URL(`./hook-npm/${name}`, import.meta.url)), join(dir, name));
    }
    for (const name of ['user.config', 'global.config']) writeFileSync(join(dir, name), '');
    // A fresh prefix and cache keep the host and other runs untouched. Empty
    // configuration files exclude user/global registry credentials and scripts.
    await exec('npm', ['ci', '--prefix', dir, '--cache', join(dir, 'cache'), '--ignore-scripts', '--no-audit', '--no-fund',
      '--userconfig', join(dir, 'user.config'), '--globalconfig', join(dir, 'global.config'), '--registry', 'https://registry.npmjs.org/'], { ...execution, cwd: dir });
    const provisioned = hookNpmEnv(dir, env);
    if (!(await usable(provisioned))) throw new Error('incompatible npm');
    return provisioned;
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    // Never include bootstrap output: it can contain local paths or proxy details.
    throw new EnvBlockedError(`${REQUIRED}; per-run npm provisioning failed`);
  }
}

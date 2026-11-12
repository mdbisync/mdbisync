// The person's clone: pulling the tracked branch into it, and what to keep
// when that pull fails.
//
// A pull that fails mid-run (a live L4-12 burst once ended on "refusing to
// merge unrelated histories") is hard to explain afterwards. So a failed
// pull writes the clone's state to a `person-git-*.txt` file in the run
// folder: where HEAD and the tracked branch point, their merge base, root
// commits, how the clone borrows objects, its reflog and a connectivity
// check. A failed run also keeps the clone itself (`finishPersonClone`).

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { GitError, type Git } from '../../../src/state/git.ts';
import type { RunContext } from './context.ts';
import type { Result } from './results.ts';

const ANY_EXIT = Array.from({ length: 256 }, (_, code) => code);

/**
 * Pulls the run's tracked branch into the person's clone: a fetch into its remote-tracking ref, then a merge of that
 * ref by name. Not `git pull`, which merges whatever FETCH_HEAD names after its fetch: a load test reads the state
 * refs into the same clone at the same time (each Linear edit reads the ids ref), and such a fetch rewrote
 * FETCH_HEAD with a state commit that shares no history with the branch ("refusing to merge unrelated histories").
 * On failure, writes diagnostics and names them in the error.
 */
export async function pullTracked(git: Git, ctx: Pick<RunContext, 'names' | 'runDir' | 'log'>): Promise<void> {
  const tracked = `refs/remotes/origin/${ctx.names.trackedBranch}`;
  let args: string[] = [];
  try {
    args = ['fetch', '--quiet', '--no-write-fetch-head', 'origin', `+refs/heads/${ctx.names.trackedBranch}:${tracked}`];
    await git.run(args);
    args = ['merge', '--quiet', '--no-edit', tracked];
    await git.run(args);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    let note: string;
    try {
      const file = await writePersonDiagnostics(git, ctx, `${args.join(' ')}: exit ${error.code}: ${error.stderr.trim()}`);
      note = `diagnostics: ${basename(file)} in the run folder`;
      ctx.log(`person clone: ${args[0]} of ${ctx.names.trackedBranch} failed; ${note}`);
    } catch (writeError) {
      // The git failure is what matters: a diagnostics file that cannot be written must not replace it.
      note = `no diagnostics: ${(writeError as Error).message}`;
    }
    throw new GitError(args, error.code, `${error.stderr.trim()} (${note})`);
  }
}

/** Hides credentials that a URL or a git message may carry: a URL's user and password, and token-like query values. */
export function redactCredentials(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
    .replace(/([?&][^=&\s]*(?:token|key|secret|password|auth|sig)[^=&\s]*=)[^&\s#]+/gi, '$1***');
}

/** A remote URL without its user, password and query; a local path or `host:path` form is returned as it is. */
export function withoutCredentials(url: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return redactCredentials(url);
  }
}

/** Writes the clone's state to `person-git-<time>-<random>.txt` in the run folder and returns its path. Read-only; a git answer never throws. */
export async function writePersonDiagnostics(git: Git, ctx: Pick<RunContext, 'names' | 'runDir'>, reason: string): Promise<string> {
  const tracked = `refs/remotes/origin/${ctx.names.trackedBranch}`;
  const commands: string[][] = [
    ['symbolic-ref', '-q', 'HEAD'],
    ['rev-parse', 'HEAD'],
    ['rev-parse', tracked],
    ['ls-remote', 'origin', `refs/heads/${ctx.names.trackedBranch}`],
    ['merge-base', '--all', 'HEAD', tracked],
    ['rev-list', '--max-parents=0', 'HEAD'],
    ['rev-list', '--max-parents=0', tracked],
    ['log', '-5', '--format=%H %P %ci %s', 'HEAD'],
    ['log', '-5', '--format=%H %P %ci %s', tracked],
    // FETCH_HEAD only for what else fetched into the clone: the pull itself no longer writes it.
    ['log', '-1', '--format=%H %P %ci %s', 'FETCH_HEAD'],
    ['rev-parse', '--is-shallow-repository'],
    ['config', '--get-all', 'remote.origin.fetch'],
    ['reflog', '-20', '--date=iso'],
    ['status', '--porcelain=v1', '--branch'],
    ['count-objects', '-v'],
    ['fsck', '--connectivity-only', '--no-dangling', '--no-progress'],
  ];
  const sections = [`reason: ${reason}`];
  for (const command of commands) {
    let text: string;
    try {
      const result = await git.run(command, { okCodes: ANY_EXIT });
      text = `exit ${result.code}\n${result.stdout.toString('utf8')}${result.stderr}`;
    } catch (error) {
      text = `could not run: ${(error as Error).message}`;
    }
    sections.push(`$ git ${command.join(' ')}\n${text.trimEnd()}`);
  }
  try {
    sections.push(`objects/info/alternates:\n${readFileSync(join(git.dir, '.git', 'objects', 'info', 'alternates'), 'utf8').trimEnd()}`);
  } catch {
    sections.push('objects/info/alternates: none');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(ctx.runDir, `person-git-${stamp}-${randomBytes(3).toString('hex')}.txt`);
  writeFileSync(file, `${redactCredentials(sections.join('\n\n'))}\n`, { flag: 'wx' });
  return file;
}

/**
 * Removes the person's clone at the end of a run, except after a failed one: then it stays in the run folder for
 * diagnosis, made safe to keep first. Its remote URL, reflogs and FETCH_HEAD lose any credentials they carried (the
 * harness passes its token through the environment, but a configured mirror URL may hold one), and it copies in the objects it borrowed from
 * the shared cache, whose unreachable objects a later cleanup of the cache may drop. A clone that cannot be made safe
 * is removed.
 */
export function finishPersonClone(runDir: string, result: Result, log: (line: string) => void): void {
  const dir = join(runDir, 'person');
  if (result !== 'fail' || !existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const git = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
  const url = git(['config', '--get', 'remote.origin.url']).stdout.trim();
  const clean = withoutCredentials(url);
  const steps = [
    ...(clean !== url ? [git(['config', 'remote.origin.url', clean])] : []),
    ...(existsSync(join(dir, '.git', 'objects', 'info', 'alternates')) ? [git(['repack', '-a', '-d', '-q'])] : []),
  ];
  let scrubbed = true;
  try {
    // Git records the URL it cloned or fetched from in the reflogs and FETCH_HEAD, query and all.
    for (const file of [...filesUnder(join(dir, '.git', 'logs')), join(dir, '.git', 'FETCH_HEAD')].filter((path) => existsSync(path))) {
      const text = readFileSync(file, 'utf8');
      const clean = redactCredentials(text);
      if (clean !== text) writeFileSync(file, clean);
    }
  } catch {
    scrubbed = false;
  }
  if (!scrubbed || steps.some((step) => step.status !== 0)) {
    log(`removed the person clone: it could not be made safe to keep (${steps.map((step) => step.stderr.trim()).filter(Boolean).join('; ') || 'its logs could not be scrubbed'})`);
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  rmSync(join(dir, '.git', 'objects', 'info', 'alternates'), { force: true });
  log(`kept the person clone for diagnosis: ${dir}`);
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]));
}

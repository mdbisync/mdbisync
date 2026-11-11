// The person's clone: pulling the tracked branch into it, and what to keep
// when that pull fails.
//
// A pull that fails mid-run (a live L4-12 burst once ended on "refusing to
// merge unrelated histories") is hard to explain afterwards: the clone is
// removed at cleanup. So a failed pull writes the clone's state to a file in
// the run folder first: where HEAD and the tracked branch point, their merge
// base, root commits, how the clone borrows objects, its reflog and a
// connectivity check.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitError, type Git } from '../../../src/state/git.ts';
import type { RunContext } from './context.ts';

const ANY_EXIT = Array.from({ length: 256 }, (_, code) => code);

/**
 * Pulls the run's tracked branch into the person's clone: a fetch into its remote-tracking ref, then a merge of that
 * ref by name. Not `git pull`, which merges whatever FETCH_HEAD names after its fetch: a load test reads the state
 * refs into the same clone at the same time (each Linear edit reads the ids ref), and such a fetch rewrites
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
    const file = await writePersonDiagnostics(git, ctx, `${args.join(' ')}: exit ${error.code}: ${error.stderr.trim()}`);
    ctx.log(`person clone: ${args[0]} of ${ctx.names.trackedBranch} failed; diagnostics in ${file}`);
    throw new GitError(args, error.code, `${error.stderr.trim()} (diagnostics: ${file})`);
  }
}

/** Writes the clone's state to `person-git-<time>.txt` in the run folder and returns its path. Read-only, never throws for a git answer. */
export async function writePersonDiagnostics(git: Git, ctx: Pick<RunContext, 'names' | 'runDir'>, reason: string): Promise<string> {
  const tracked = ctx.names.trackedBranch;
  const commands: string[][] = [
    ['symbolic-ref', '-q', 'HEAD'],
    ['rev-parse', 'HEAD', 'FETCH_HEAD', `refs/remotes/origin/${tracked}`],
    ['ls-remote', 'origin', `refs/heads/${tracked}`],
    ['merge-base', '--all', 'HEAD', 'FETCH_HEAD'],
    ['merge-base', '--all', 'HEAD', `refs/remotes/origin/${tracked}`],
    ['rev-list', '--max-parents=0', 'HEAD'],
    ['rev-list', '--max-parents=0', `refs/remotes/origin/${tracked}`],
    ['rev-list', '--max-parents=0', 'FETCH_HEAD'],
    ['log', '-5', '--format=%H %P %ci %s', 'HEAD'],
    ['log', '-5', '--format=%H %P %ci %s', `refs/remotes/origin/${tracked}`],
    ['log', '-5', '--format=%H %P %ci %s', 'FETCH_HEAD'],
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
  const file = join(ctx.runDir, `person-git-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  writeFileSync(file, `${sections.join('\n\n')}\n`);
  return file;
}

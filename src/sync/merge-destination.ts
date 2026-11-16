// Where a merge of a sync pull request lands. GitHub's merge endpoint binds
// the head commit, not the branch the pull request merges into: a person who
// can push may change the pull request's base, or push to the tracked branch,
// after the sync checked the merge. So the sync reads both again right before
// it merges, and after the merge it verifies that the merge commit is on the
// tracked branch, on top of the commit it checked. A merge that landed
// anywhere else is reported for a person; it cannot be taken back.

import { setTimeout as sleep } from 'node:timers/promises';
import { type GitHubRepository, PullRequestError, readPullRequest } from '../pull-request/index.ts';
import { type Git, type Oid, type StateConfig, branchRef, lsRemote } from '../state/index.ts';

/** Where a merge landed when it is not where the sync checked it. */
export interface MisplacedMerge {
  /** The branch GitHub merged into; null when GitHub did not say. */
  branch: string | null;
  /** The merge commit GitHub made. */
  commit: string;
}

/** How often, and how far apart, the tracked branch is read again for a merge it does not show yet. */
const LANDING_READS = 3;
const LANDING_PAUSE_MS = 1000;

/** The tracked branch's commit on the remote now, by its exact name; null when the branch is gone. */
async function remoteTip(git: Git, config: StateConfig): Promise<Oid | null> {
  const ref = branchRef(config.trackedBranch);
  return (await lsRemote(git, config.remote, [ref])).get(ref) ?? null;
}

/**
 * Whether the pull request still merges into the tracked branch, and that
 * branch is still at `tracked`, the commit the merge was checked against.
 * Read right before the merge; a change after this read is caught by
 * `verifyMerge`.
 */
export async function destinationHolds(git: Git, config: StateConfig, github: GitHubRepository, number: number, tracked: Oid): Promise<boolean> {
  // Both at once: the moment between this read and the merge is what a change can still slip into.
  const [pr, tip] = await Promise.all([readPullRequest(github, number), remoteTip(git, config)]);
  return pr.state === 'open' && pr.base === config.trackedBranch && tip === tracked;
}

/**
 * Null when the merge commit `merged` is on the tracked branch with `tracked`
 * as its first parent; otherwise where it landed. The merged pull request's
 * base can no longer change, so it names the branch GitHub merged into. A
 * merge into the tracked branch that the remote does not show yet is read
 * again a few times before it counts as misplaced.
 */
export async function verifyMerge(git: Git, config: StateConfig, github: GitHubRepository, number: number, tracked: Oid, merged: string): Promise<MisplacedMerge | null> {
  let base: string | null;
  try {
    base = (await readPullRequest(github, number)).base;
  } catch (error) {
    // The merge already happened: a failed read must not hide where it went, so the tracked branch decides alone.
    if (!(error instanceof PullRequestError)) throw error;
    base = null;
  }
  if (base !== null && base !== config.trackedBranch) return { branch: base, commit: merged };
  for (let read = 1; ; read += 1) {
    const landing = await onTracked(git, config, tracked, merged);
    if (landing === 'checked') return null;
    // On the tracked branch, but on top of a commit the sync did not check: a push landed in that moment.
    if (landing === 'unchecked') return { branch: config.trackedBranch, commit: merged };
    if (read === LANDING_READS) return { branch: base, commit: merged };
    await sleep(LANDING_PAUSE_MS);
  }
}

/** Whether `merged` is on the tracked branch: on top of `tracked` (`checked`), on top of another commit, or not shown. */
async function onTracked(git: Git, config: StateConfig, tracked: Oid, merged: string): Promise<'checked' | 'unchecked' | 'absent'> {
  const tip = await remoteTip(git, config);
  if (tip === null) return 'absent';
  await git.run(['fetch', '--no-tags', '--no-write-fetch-head', config.remote, branchRef(config.trackedBranch)]);
  // A commit the fetch did not bring is not on the branch: merge-base then exits 128.
  if ((await git.run(['merge-base', '--is-ancestor', merged, tip], { okCodes: [0, 1, 128] })).code !== 0) return 'absent';
  return (await git.text(['rev-parse', `${merged}^1`])) === tracked ? 'checked' : 'unchecked';
}

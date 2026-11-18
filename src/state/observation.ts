// The `linear` state ref holds what the sync last observed in Linear and
// wrote. Anyone who may push to the repository can move that ref, and the
// sync proposes its tree to the tracked branch, so every `linear` commit the
// sync writes carries a signature keyed by the sync's own secret: over its
// tree, its parents and its message. The sync builds on a tip only when it
// signed that tip, or when the tracked branch already holds it; a commit it
// did not write never becomes the base of a signed one.

import { type Git, type Oid } from './git.ts';
import { isAncestor } from './state.ts';
import { type PushedKey } from './pushed.ts';

const SIGNATURE = 'Sync-signature';
const SIGNED = new RegExp(`^([\\s\\S]*)\\n\\n${SIGNATURE}: ([0-9a-f]{64})\\n$`);

/** Signs a `linear` commit: pass as `sign` to `commitTree`. */
export function signObservation(key: PushedKey): (tree: Oid, parents: readonly Oid[], message: string) => string {
  return (tree, parents, message) => {
    const text = message.replace(/\n+$/, '');
    return `${text}\n\n${SIGNATURE}: ${key.observationMac(tree, parents, text)}\n`;
  };
}

/** Whether the sync signed `commit` as a `linear` commit of this repository. */
export async function signedObservation(git: Git, commit: Oid, key: PushedKey): Promise<boolean> {
  const raw = (await git.run(['cat-file', 'commit', commit])).stdout.toString('utf8');
  const split = raw.indexOf('\n\n');
  if (split < 0) return false;
  const headers = raw.slice(0, split).split('\n');
  const signed = SIGNED.exec(raw.slice(split + 2));
  if (signed === null) return false;
  const tree = headers.find((line) => line.startsWith('tree '))?.slice(5);
  const parents = headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7));
  return tree !== undefined && key.verifiesObservation(tree, parents, signed[1] as string, signed[2] as string);
}

/**
 * Whether the sync may build on `linear`: it signed that commit, or the
 * tracked branch holds it, so its every file already passed the tracked
 * branch's rules. A ref the sync wrote before it signed its commits is
 * trusted once its pull request merged.
 */
export async function trustedObservation(git: Git, linear: Oid, tracked: Oid, key: PushedKey): Promise<boolean> {
  return (await signedObservation(git, linear, key)) || (await isAncestor(git, linear, tracked));
}

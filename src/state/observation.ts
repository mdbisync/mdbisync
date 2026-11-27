// The `linear` state ref holds what the sync last observed in Linear and
// wrote. Anyone who may push to the repository can move that ref, and the
// sync proposes its tree to the tracked branch, so every `linear` commit the
// sync writes carries a signature keyed by the sync's own secret: over its
// tree, its parents and its message. The sync builds on a tip only when it
// signed that tip, or when the tip holds a tree the tracked branch itself
// held; a commit it did not write never becomes the base of a signed one.

import { showCommit } from './commit-format.ts';
import { type Git, type Oid } from './git.ts';
import { type PushedKey } from './pushed.ts';

const SIGNATURE = 'Sync-signature';
const SIGNED = new RegExp(`^([\\s\\S]*)\\n\\n${SIGNATURE}: ([0-9a-f]{64})\\n$`);

/** Signs a `linear` commit: pass as `sign` to `commitTree`. */
export function signObservation(key: PushedKey): (tree: Oid, parents: readonly Oid[], message: string) => string {
  return signMessage(key.observationMac.bind(key));
}

/** Signs the message carrying capture checkpoints in an `ids` commit. */
export function signIdsTrailers(key: PushedKey): (tree: Oid, parents: readonly Oid[], message: string) => string {
  return signMessage(key.idsTrailersMac.bind(key));
}

function signMessage(mac: (tree: Oid, parents: readonly Oid[], text: string) => string): (tree: Oid, parents: readonly Oid[], message: string) => string {
  return (tree, parents, message) => {
    const text = message.replace(/\n+$/, '');
    return `${text}\n\n${SIGNATURE}: ${mac(tree, parents, text)}\n`;
  };
}

/** Whether the sync signed `commit` as a `linear` commit of this repository. */
export async function signedObservation(git: Git, commit: Oid, key: PushedKey): Promise<boolean> {
  return (await verifiedMessage(git, commit, key.verifiesObservation.bind(key))) !== undefined;
}

/** The authenticated message text of an `ids` commit, without its signature trailer. */
export function signedIdsMessage(git: Git, commit: Oid, key: PushedKey): Promise<string | undefined> {
  return verifiedMessage(git, commit, key.verifiesIdsTrailers.bind(key));
}

async function verifiedMessage(git: Git, commit: Oid, verifies: (tree: Oid, parents: readonly Oid[], text: string, mac: string) => boolean): Promise<string | undefined> {
  const found = await git.readObject(commit);
  const raw = (found?.type === 'commit' ? found.content : (await git.run(['cat-file', 'commit', commit])).stdout).toString('utf8');
  const split = raw.indexOf('\n\n');
  if (split < 0) return undefined;
  // The sync writes UTF-8 without an encoding header; with one, git reads another subject than the signed bytes.
  if (raw.slice(0, split).split('\n').some((line) => line.startsWith('encoding '))) return undefined;
  const signed = SIGNED.exec(raw.slice(split + 2));
  if (signed === null) return undefined;
  // The tree and parents as git reads them, whatever other headers the object carries.
  const [tree = '', parents = ''] = (await showCommit(git, '%T%n%P', commit)).split('\n');
  const [, text, mac] = signed;
  return verifies(tree, parents.split(' ').filter(Boolean), text!, mac!) ? text : undefined;
}

/**
 * Whether the sync may build on `linear`: it signed that commit, or the
 * commit holds a tree the tracked branch held on its first-parent history,
 * whose every file passed that branch's rules. A commit merged in from
 * another branch is not enough: a branch's intermediate commits were never
 * checked as the tracked branch. A `linear` the sync wrote before it signed
 * its commits counts when its record holds the tracked branch's tree.
 */
export async function trustedObservation(git: Git, linear: Oid, tracked: Oid, key: PushedKey): Promise<boolean> {
  if (await signedObservation(git, linear, key)) return true;
  const tree = await git.revParse(`${linear}^{tree}`);
  const trees = (await git.text(['log', '--first-parent', '--format=%T', tracked])).split('\n');
  return trees.includes(tree);
}

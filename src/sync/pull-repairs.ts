// A checked branch view is derived from an observation without changing the observation ref.
import { createHash } from 'node:crypto';
import { type Git, type Oid, type IdMap, type CommitIdentity, listTree, readBlobs, buildTree } from '../state/index.ts';
import { oneLine } from './head-check.ts';

export async function checkedPullView(git: Git, linear: Oid, ids: IdMap, identity: CommitIdentity): Promise<{commit: Oid; notes: string[]}> {
  const pending = [...ids].filter(([, entry]) => entry.pullRewrite !== undefined);
  if (pending.length === 0) return {commit: linear, notes: []};
  const entries = new Map((await listTree(git, linear)).map(entry => [entry.path, entry]));
  const files = pending.flatMap(([path]) => { const file = entries.get(path); return file?.type === 'blob' ? [file] : []; });
  const blobs = await readBlobs(git, files.map(file => file.oid));
  const changes = new Map<string, string>();
  const notes: string[] = [];
  for (const [path, entry] of pending) {
    const file = entries.get(path);
    const source = file === undefined ? undefined : blobs.get(file.oid);
    const repair = entry.pullRewrite!;
    if (source === undefined || createHash('sha256').update(source).digest('hex') !== repair.hash) continue;
    if (source.toString('utf8') === repair.replacement) continue;
    changes.set(path, repair.replacement);
    for (const image of repair.images) notes.push(`- ${oneLine(path)}: image ${image.image} of ${image.total} (line ${image.line}).`);
  }
  if (changes.size === 0) return {commit: linear, notes};
  const tree = await buildTree(git, linear, changes);
  const date = await git.text(['show', '-s', '--format=%cI', linear]);
  const commit = await git.text(['commit-tree', '--no-gpg-sign', tree, '-p', linear, '-m', 'Apply checked image and link repairs'], {env: {
    GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
    GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
  }});
  return {commit, notes};
}

/** Recover conservative plain-link provenance when the ids ref is rebuilt. */
export async function readPlainFileProvenance(git: Git, linear: Oid): Promise<Map<string, Set<string>>> {
  const log = await git.text(['log', '--first-parent', '--format=%B', '--grep=^Plain-link:', linear]);
  const result = new Map<string, Set<string>>();
  for (const match of log.matchAll(/^Plain-link: (\S+) (\S+)$/gm)) {
    try {
      const id = decodeURIComponent(match[1]!);
      const target = decodeURIComponent(match[2]!);
      if (!result.has(id)) result.set(id, new Set());
      result.get(id)!.add(target);
    } catch { /* A malformed trailer grants no upload permission. */ }
  }
  return result;
}

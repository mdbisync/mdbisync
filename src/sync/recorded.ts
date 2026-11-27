// The documents a run recorded as Linear held them, with the update time
// Linear gave each. A step that writes the `linear` record from Linear
// (the initial sync to Linear, the write step) names them in its `ids`
// commit, so the next capture does not read again a document whose update
// time is still the recorded one: its text is in the record already. Any
// later change in Linear (content, title, place, but also an icon, a color
// or a comment) moves the time, and the capture reads it again.
//
// Only signed checkpoints count. The latest signed cursor covers every
// document recorded before it.

import { createHash } from 'node:crypto';
import type { LinearDocument } from '../linear/index.ts';
import { type Git, type Oid, type PushedKey, signedIdsMessage } from '../state/index.ts';
import { message } from '../messages.ts';

const RECORDED = /^Document-recorded: (\S+) (\S+)$/gm;
const CURSOR = /^Capture-through: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)$/m;
const CURSOR_BATCH_SIZE = 32;

export function captureCursorTrailer(through: string): string {
  return `Capture-through: ${through}`;
}

/** An exact comparison of the body as Linear returned it, including its update time. */
export function observedDigest(document: LinearDocument): string | undefined {
  if (document.content === undefined) return undefined;
  return createHash('sha256').update(JSON.stringify([document.content, document.updatedAt])).digest('hex');
}

/** A decoration response may refresh the timestamp of an already accepted body. */
export function matchesObservedBody(document: LinearDocument, observed: LinearDocument): boolean {
  return document.id === observed.id && document.content !== undefined && document.content === observed.content
    && document.title === observed.title && document.projectId === observed.projectId && document.teamId === observed.teamId
    && !document.trashed && document.archivedAt === null;
}

/** A document's update time in the form the capture cursor uses, so times compare as text. */
export function recordedTime(updatedAt: string): string {
  const time = new Date(updatedAt);
  if (!Number.isFinite(time.getTime())) throw new Error(message('sync.invalid-update-time'));
  return time.toISOString();
}

/** The trailers naming each recorded document (id to its update time), sorted by id. */
export function recordedTrailers(recorded: ReadonlyMap<string, string>): string[] {
  return [...recorded].filter(([id]) => /^\S+$/.test(id)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, time]) => `Document-recorded: ${id} ${recordedTime(time)}`);
}

/** The commit message with the recorded documents' trailers. */
export function withRecorded(message: string, recorded: ReadonlyMap<string, string>): string {
  return recorded.size === 0 ? message : `${message}\n\n${recordedTrailers(recorded).join('\n')}`;
}

/** Read the last signed cursor and the signed document checkpoints that came after it. */
export async function readCaptureCheckpoints(git: Git, ids: Oid | null, key: PushedKey): Promise<{cursor: string | null; recorded: Map<string, string>; needsCursor: boolean}> {
  const recorded = new Map<string, string>();
  if (ids === null) return {cursor: null, recorded, needsCursor: false};
  const {checkpoint, sawCursor} = await readCaptureCursor(git, ids, key);
  const range = checkpoint === null ? ids : `${checkpoint.commit}..${ids}`;
  const log = await git.text(['log', '--first-parent', '--format=%H', '--grep=^Document-recorded: ', range]);
  let needsCursor = checkpoint === null && sawCursor;
  for (const commit of log.trim().split('\n').filter(Boolean)) {
    const message = await signedIdsMessage(git, commit, key);
    if (message === undefined) {
      if (checkpoint === null) needsCursor = true;
      continue;
    }
    // Newest first: a later record of a document replaces an earlier one.
    const seen = new Map<string, string>();
    for (const match of message.matchAll(RECORDED)) seen.set(match[1] as string, match[2] as string);
    for (const [id, time] of seen) if (!recorded.has(id)) recorded.set(id, time);
  }
  return {cursor: checkpoint?.time ?? null, recorded, needsCursor};
}

/** Read the newest signed cursor. Ordinary commits may sit above it in `ids` history. */
export async function readCaptureCursor(git: Git, ids: Oid | null, key: PushedKey): Promise<{checkpoint: {commit: Oid; time: string} | null; sawCursor: boolean}> {
  let tip = ids;
  let sawCursor = false;
  while (tip !== null) {
    const log = await git.text(['log', `-${CURSOR_BATCH_SIZE}`, '--first-parent', '--format=%H %P', '--grep=^Capture-through: ', tip]);
    if (log === '') break;
    sawCursor = true;
    const candidates = log.split('\n');
    for (const line of candidates) {
      const [commit] = line.split(' ');
      const message = await signedIdsMessage(git, commit!, key);
      const time = message === undefined ? undefined : CURSOR.exec(message)?.[1];
      if (time !== undefined) return {checkpoint: {commit: commit!, time}, sawCursor};
    }
    if (candidates.length < CURSOR_BATCH_SIZE) break;
    tip = candidates.at(-1)!.split(' ')[1] || null;
  }
  return {checkpoint: null, sawCursor};
}

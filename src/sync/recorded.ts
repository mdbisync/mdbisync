// The documents a run recorded as Linear held them, with the update time
// Linear gave each. A step that writes the `linear` record from Linear
// (the initial sync to Linear, the write step) names them in its `ids`
// commit, so the next capture does not read again a document whose update
// time is still the recorded one: its text is in the record already. Any
// later change in Linear (content, title, place, but also an icon, a color
// or a comment) moves the time, and the capture reads it again.
//
// Only the `ids` commits after the latest capture cursor count: that cursor
// covers every time recorded before it.

import { type Git, type Oid } from '../state/index.ts';

const RECORDED = /^Document-recorded: (\S+) (\S+)$/gm;

/** A document's update time in the form the capture cursor uses, so times compare as text. */
export function recordedTime(updatedAt: string): string {
  const time = new Date(updatedAt);
  if (!Number.isFinite(time.getTime())) throw new Error('a document has an invalid update time');
  return time.toISOString();
}

/** The trailers naming each recorded document (id to its update time), sorted by id. */
export function recordedTrailers(recorded: ReadonlyMap<string, string>): string[] {
  return [...recorded].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, time]) => `Document-recorded: ${id} ${recordedTime(time)}`);
}

/** The commit message with the recorded documents' trailers. */
export function withRecorded(message: string, recorded: ReadonlyMap<string, string>): string {
  return recorded.size === 0 ? message : `${message}\n\n${recordedTrailers(recorded).join('\n')}`;
}

/** The documents recorded since the latest capture cursor: id to update time, the newest record of each. */
export async function readRecorded(git: Git, ids: Oid | null): Promise<Map<string, string>> {
  if (ids === null) return new Map();
  const cursor = (await git.text(['log', '-1', '--format=%H', '--grep=^Capture-through:', ids])).trim();
  const log = await git.text(['log', '--format=%B%x00', cursor === '' ? ids : `${cursor}..${ids}`]);
  const recorded = new Map<string, string>();
  // Newest first: a later record of a document replaces an earlier one.
  for (const message of log.split('\0')) {
    const seen = new Map<string, string>();
    for (const match of message.matchAll(RECORDED)) seen.set(match[1] as string, match[2] as string);
    for (const [id, time] of seen) if (!recorded.has(id)) recorded.set(id, time);
  }
  return recorded;
}

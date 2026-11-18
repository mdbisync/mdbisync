import { createHash, randomUUID } from 'node:crypto';
import { detectConflicts } from '../merge/index.ts';
import type { LinearClient, LinearDocument } from '../linear/index.ts';
import type { HoldNotice, IdEntry } from '../state/index.ts';
import type { ImageFinding, FileFinding } from './assets.ts';
import { message } from '../messages.ts';

/**
 * Blocked and suspended show the same red exclamation mark: the document's
 * changes do not reach Git, and the comment says why. It differs from the
 * orange conflict mark by color only, so every check of a mark compares both
 * icon and color. A document still showing an earlier mark is repainted when
 * the sync next reconciles its mark.
 */
export const MARKS = {
  conflict: { icon: 'Alert', color: '#F2994A' },
  blocked: { icon: 'Alert', color: '#EB5757' },
  suspended: { icon: 'Alert', color: '#EB5757' },
} as const;

export const CONFLICT_COMMENT = 'This document contains conflicting versions. Edit the document here or in Git, keep the text you want, and delete every "Sync conflict" marker throughout the document. The alert clears after the next sync.';

/** The blocked mark's comment opens with this line; a list of hooks and lines follows. */
export const BLOCKED_COMMENT = 'Security checks rejected this document. Fix the listed findings and sync again.';

/**
 * Resolves an episode's comment before its id is forgotten. Every receipt
 * needs a remote ownership check, including comments not confirmed posted
 * because a create response or its saved receipt was lost.
 */
export async function resolveHold(linear: Pick<LinearClient, 'resolveComment' | 'commentExists'>, hold: HoldNotice, documentId: string): Promise<void> {
  if (await linear.commentExists(hold.id, documentId)) await linear.resolveComment(hold.id);
}

/** A released episode's comment still to be resolved: its entry stays, even when its document is gone, until the hold step resolves it. */
export function releasedHold(entry: IdEntry): boolean {
  return entry.suspended === undefined && entry.saved?.hold !== undefined;
}

export interface SecurityFinding {
  hook: string;
  line: number;
}

export type BlockedFinding = SecurityFinding | ImageFinding | FileFinding;

export type MarkClient = Pick<LinearClient, 'updateDocument' | 'ensureDocumentComment' | 'resolveComment' | 'commentExists'>;
export type MarkState = 'conflict' | 'blocked' | 'clear';

export interface MarkOptions {
  /** A current read including content, not a merge result that has not been written. */
  document: LinearDocument;
  entry: IdEntry;
  linear: MarkClient;
  /** Current image and security-hook findings. Blocked takes precedence over conflict. */
  blocked?: readonly BlockedFinding[];
  /** Must durably record the entry in ids before resolving. Never just queue it. */
  persistEntry: (entry: IdEntry) => Promise<void>;
  /**
   * The id of a new notice's comment; random by default. A caller that may run
   * again without the entry it saved (a rebuilt state) passes an id derived from
   * the episode, so the comment posted before is found instead of added again.
   */
  noticeId?: (state: Exclude<MarkState, 'clear'>) => string;
  /**
   * Called as soon as the conflict notice's requests succeed: `set` when the
   * comment is posted (or the one begun before is found), `resolved` when a
   * conflict notice is resolved. Each costs up to two requests, which the
   * run reports even when a later step of this mark fails. A notice already
   * recorded as posted costs nothing and is not reported.
   */
  onConflictNotice?: (change: keyof ConflictNotices) => void;
}

export interface MarkResult {
  state: MarkState;
  entry: IdEntry;
  updated: boolean;
  commented: boolean;
}

/** The documents whose conflict notice a run set or resolved, by path, once per time it did. */
export interface ConflictNotices {
  set: string[];
  resolved: string[];
}

export function noConflictNotices(): ConflictNotices {
  return { set: [], resolved: [] };
}

export const IMAGE_BLOCKED_COMMENT = 'Some images in this document cannot be synchronized. Fix the listed images and sync again.';

function blockedComment(findings: readonly BlockedFinding[]): string {
  const images = findings.filter((finding): finding is ImageFinding => 'image' in finding);
  const files = findings.filter((finding): finding is FileFinding => 'file' in finding);
  const hooks = findings.filter((finding): finding is SecurityFinding => 'hook' in finding);
  const locations = [...new Set(hooks.map(({ hook, line }) => {
    // Hook configuration is untrusted input. Never copy matched text or a
    // malformed hook name into a public comment.
    const name = /^[a-zA-Z0-9_.-]{1,128}$/.test(hook) ? hook : 'security-check';
    // Line 0 is a finding on the title (`checkTitle`).
    const location = line === 0 ? ', in the title' : Number.isSafeInteger(line) && line > 0 ? `, line ${line}` : '';
    return `- Hook \`${name}\`${location}.`;
  }))].sort();
  const sections: string[] = [];
  const imageReasons: Record<ImageFinding['reason'], string> = {
    'not-uploaded': 'not uploaded to this workspace. Upload the file instead of linking to it.',
    'unreadable': 'the uploaded file cannot be read. Remove it or upload it again.',
    'too-large': 'the uploaded file is larger than 10 MB.',
    'unsupported-type': 'the uploaded file is not a supported image or document. Remove it or upload the original file.',
  };
  if (images.length > 0) sections.push(`${IMAGE_BLOCKED_COMMENT}\n\n${images.map(({image, total, line, reason}) => `- Image ${image} of ${total} (line ${line}): ${imageReasons[reason]}`).join('\n')}`);
  if (files.length > 0) sections.push(`Some files in this document cannot be synchronized. Fix the listed files and sync again.\n\n${files.map(({file, total, line, reason}) => `- File ${file} of ${total} (line ${line}): ${imageReasons[reason]}`).join('\n')}`);
  if (locations.length > 0) sections.push(`${BLOCKED_COMMENT}\n\n${locations.join('\n')}`);
  return sections.join('\n\n');
}

/**
 * Reconcile one document's visible status from its current text and security
 * findings. All marks share exactly one saved original decoration.
 * No conflict flag is stored: marker paragraphs remain the authority.
 */
export async function reconcileDocumentMark(options: MarkOptions): Promise<MarkResult> {
  const { document, linear, persistEntry } = options;
  if (document.id !== options.entry.id) throw new Error(message('sync.entry-mismatch'));
  if (document.content === undefined) throw new Error(message('sync.needs-content'));
  let entry: IdEntry = structuredClone(options.entry);
  const blocked = options.blocked ?? [];
  const state: MarkState = blocked.length > 0 ? 'blocked' : detectConflicts(document.content ?? '').length > 0 ? 'conflict' : 'clear';
  const result: MarkResult = { state, entry, updated: false, commented: false };
  if (document.trashed || document.archivedAt !== null) return result;

  // Suspension decorations are reconciled after the lane's state push.
  if (entry.suspended !== undefined && blocked.length === 0) return result;
  // Saved ids and receipts are untrusted. Authorize every existing comment
  // this reconciliation may change before changing a comment or decoration.
  const body = state === 'clear' ? '' : state === 'conflict' ? CONFLICT_COMMENT : blockedComment(blocked);
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const previousNotice = entry.saved?.notice;
  const changesDecoration = state !== 'clear' && (document.icon !== MARKS[state].icon || document.color !== MARKS[state].color);
  // A conflict notice is resolved when its mark goes. A blocked notice is
  // never resolved: it stays open as the record of what the checks rejected.
  const resolvesNotice = previousNotice?.kind === 'conflict' && state !== 'conflict';
  const updatesNotice = previousNotice?.kind === state && (!previousNotice.posted || previousNotice.bodyHash !== bodyHash || changesDecoration);
  const changesNotice = previousNotice !== undefined && (resolvesNotice || updatesNotice);
  const noticeExists = changesNotice ? await linear.commentExists(previousNotice.id, document.id) : false;
  // A released episode whose comment the hold step has not reached yet (the per-run limit, a failed write).
  if (releasedHold(entry) && entry.saved !== undefined) {
    // Nothing else to show: the hold step clears it and reports it, within its limit.
    if (state === 'clear' && entry.saved.notice === undefined) return result;
    // A conflict or blocked mark (new, or one that has just cleared) takes it over: the comment is resolved before its mark goes.
    await resolveHold(linear, entry.saved.hold as HoldNotice, document.id);
    const { hold: _hold, ...saved } = entry.saved;
    entry = { ...entry, saved };
    await persistEntry(entry);
    result.entry = entry;
  }

  if (resolvesNotice) {
    // Cleared, or replaced by a blocked notice: the conflict notice is not
    // left open. A person can delete it before fixing the document. Check for
    // its absence; failed reads or resolutions retain the notice for retry.
    if (noticeExists) await linear.resolveComment(previousNotice.id);
    options.onConflictNotice?.('resolved');
  }

  if (state === 'clear') {
    if (entry.saved === undefined) return result;
    if (document.icon !== entry.saved.icon || document.color !== entry.saved.color) {
      await linear.updateDocument(document.id, { icon: entry.saved.icon, color: entry.saved.color });
      result.updated = true;
    }
    // A blocked notice is forgotten here, not resolved.
    const { saved: _saved, ...restored } = entry;
    await persistEntry(restored);
    result.entry = restored;
    return result;
  }

  if (!document.documentContentId) throw new Error(message('sync.needs-comment-target'));
  const saved = entry.saved ?? { icon: document.icon, color: document.color };
  const previous = saved.notice;
  // A new notice replaces the receipt of any other kind; a blocked one stays open in Linear.
  const notice = previous?.kind === state
    ? { ...previous, bodyHash, posted: previous.posted && previous.bodyHash === bodyHash }
    : { id: options.noticeId?.(state) ?? randomUUID(), kind: state, bodyHash, posted: false };
  if (entry.saved === undefined || previous?.kind !== state || previous.bodyHash !== bodyHash) {
    entry = { ...entry, saved: { ...saved, notice } };
    await persistEntry(entry);
    result.entry = entry;
  }
  const mark = MARKS[state];
  if (document.icon !== mark.icon || document.color !== mark.color) {
    await linear.updateDocument(document.id, mark);
    result.updated = true;
  }
  if (notice.posted) return result;
  // The pending id is durable before the mutation. Lost responses and failed
  // receipt saves can safely resume; changed blocked locations update this id.
  const comment = await linear.ensureDocumentComment(document.documentContentId, body, notice.id, true);
  if (state === 'conflict') options.onConflictNotice?.('set');
  const posted = { ...entry, saved: { ...saved, notice: { ...notice, posted: true } } };
  await persistEntry(posted);
  result.entry = posted;
  result.commented = comment.created;
  return result;
}

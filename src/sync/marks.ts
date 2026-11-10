import { createHash, randomUUID } from 'node:crypto';
import { detectConflicts } from '../merge/index.ts';
import type { LinearClient, LinearDocument } from '../linear/index.ts';
import type { IdEntry } from '../state/index.ts';
import { message } from '../messages.ts';

export const MARKS = {
  conflict: { icon: 'Alert', color: '#F2994A' },
  blocked: { icon: 'Cross', color: '#EB5757' },
} as const;

export const CONFLICT_COMMENT = 'This document contains conflicting versions. Edit the document here or in Git, keep the text you want, and remove every conflict marker paragraph throughout the document. The alert clears after the next sync.';

/** The blocked mark's comment opens with this line; a list of hooks and lines follows. */
export const BLOCKED_COMMENT = 'Security checks rejected this document. Fix the listed findings and sync again.';

export interface SecurityFinding {
  hook: string;
  line: number;
}

export type MarkClient = Pick<LinearClient, 'updateDocument' | 'ensureDocumentComment'>;
export type MarkState = 'conflict' | 'blocked' | 'clear';

export interface MarkOptions {
  /** A current read including content, not a merge result that has not been written. */
  document: LinearDocument;
  entry: IdEntry;
  linear: MarkClient;
  /** Current security-hook findings. Blocked takes precedence over conflict. */
  blocked?: readonly SecurityFinding[];
  /** Must durably record the entry in ids before resolving. Never just queue it. */
  persistEntry: (entry: IdEntry) => Promise<void>;
}

export interface MarkResult {
  state: MarkState;
  entry: IdEntry;
  updated: boolean;
  commented: boolean;
}

function blockedComment(findings: readonly SecurityFinding[]): string {
  const locations = [...new Set(findings.map(({ hook, line }) => {
    // Hook configuration is untrusted input. Never copy matched text or a
    // malformed hook name into a public comment.
    const name = /^[a-zA-Z0-9_.-]{1,128}$/.test(hook) ? hook : 'security-check';
    const location = Number.isSafeInteger(line) && line > 0 ? `, line ${line}` : '';
    return `- Hook \`${name}\`${location}.`;
  }))].sort();
  return `${BLOCKED_COMMENT}\n\n${locations.join('\n')}`;
}

/**
 * Reconcile one document's visible status from its current text and security
 * findings. Alert and Cross share exactly one saved original decoration.
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

  if (state === 'clear') {
    if (entry.saved === undefined) return result;
    if (document.icon !== entry.saved.icon || document.color !== entry.saved.color) {
      await linear.updateDocument(document.id, { icon: entry.saved.icon, color: entry.saved.color });
      result.updated = true;
    }
    const { saved: _saved, ...restored } = entry;
    await persistEntry(restored);
    result.entry = restored;
    return result;
  }

  if (!document.documentContentId) throw new Error(message('sync.needs-comment-target'));
  const body = state === 'conflict' ? CONFLICT_COMMENT : blockedComment(blocked);
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const saved = entry.saved ?? { icon: document.icon, color: document.color };
  const previous = saved.notice;
  const notice = previous?.kind === state
    ? { ...previous, bodyHash, posted: previous.posted && previous.bodyHash === bodyHash }
    : { id: randomUUID(), kind: state, bodyHash, posted: false };
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
  const posted = { ...entry, saved: { ...saved, notice: { ...notice, posted: true } } };
  await persistEntry(posted);
  result.entry = posted;
  result.commented = comment.created;
  return result;
}

import { createHash } from 'node:crypto';
import { detectConflicts } from '../merge/index.ts';
import type { LinearClient, LinearDocument } from '../linear/index.ts';
import type { IdEntry } from '../state/index.ts';

export const MARKS = {
  conflict: { icon: 'Alert', color: '#F2994A' },
  blocked: { icon: 'Cross', color: '#EB5757' },
} as const;

export const CONFLICT_COMMENT = 'This document contains conflicting versions. Edit the document here or in Git, keep the text you want, and remove all three conflict marker paragraphs. The alert clears after the next sync.';

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
  return `Security checks rejected this document. Fix the listed findings and sync again.\n\n${locations.join('\n')}`;
}

/** A stable UUID v4-shaped identifier makes the same notice retryable. */
function noticeId(documentContentId: string, body: string): string {
  const bytes = createHash('sha256').update('document-status-notice/v1\0').update(documentContentId).update('\0').update(body).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Reconcile one document's visible status from its current text and security
 * findings. Alert and Cross share exactly one saved original decoration.
 * No conflict flag is stored: marker paragraphs remain the authority.
 */
export async function reconcileDocumentMark(options: MarkOptions): Promise<MarkResult> {
  const { document, linear, persistEntry } = options;
  if (document.id !== options.entry.id) throw new Error('Document and id entry do not match');
  if (document.content === undefined) throw new Error('Status reconciliation requires document content');
  let entry: IdEntry = structuredClone(options.entry);
  const blocked = options.blocked ?? [];
  const state: MarkState = blocked.length > 0 ? 'blocked' : detectConflicts(document.content ?? '').length > 0 ? 'conflict' : 'clear';
  const result: MarkResult = { state, entry, updated: false, commented: false };
  if (document.trashed || document.archivedAt !== null) return result;

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

  if (!document.documentContentId) throw new Error('A marked document requires a comment target');
  if (entry.saved === undefined) {
    entry = { ...entry, saved: { icon: document.icon, color: document.color } };
    await persistEntry(entry);
    result.entry = entry;
  }
  const mark = MARKS[state];
  if (document.icon !== mark.icon || document.color !== mark.color) {
    await linear.updateDocument(document.id, mark);
    result.updated = true;
  }
  const body = state === 'conflict' ? CONFLICT_COMMENT : blockedComment(blocked);
  // Check even when the icon already matches: a previous run may have stopped
  // between marking and commenting. The stable remote id prevents duplicates.
  const comment = await linear.ensureDocumentComment(document.documentContentId, body, noticeId(document.documentContentId, body));
  result.commented = comment.created;
  return result;
}

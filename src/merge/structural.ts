// Structural conflicts: one side deletes or renames a document while the
// other side edits or renames it. The rules keep every edit:
//
// - a change (an edit or a rename) on one side beats a delete on the other;
// - when both sides rename differently, the tracked branch's path wins and
//   the Linear title is set back, with a comment;
// - text is never chosen, it is merged three-way (mergeMarkdown), so a text
//   conflict in the same run becomes the usual marker paragraphs;
// - every case ends with at most one document and one file.

import { splitFile } from '../format/markdown.ts';
import { detectConflicts } from './markers.ts';
import type { Conflict } from './markers.ts';
import { mergeMarkdown } from './merge.ts';

/** One side's version of a document: its file path and full file text. */
export interface Version {
  path: string;
  text: string;
}

export interface StructuralInput {
  /** The base version: the document as both sides last agreed on it. */
  base: Version;
  /** The tracked branch's version, or null when git deleted the file. */
  git: Version | null;
  /**
   * Linear's version (as captured onto the `linear` state ref), or null when
   * the document was trashed, deleted or moved out of every mapped place.
   */
  linear: Version | null;
  /** Linear no longer has the document at all, so it cannot be restored. Read only when `linear` is null. */
  linearGone?: boolean;
}

export type StructuralKind =
  /** No structural change on either side: an ordinary text merge. */
  | 'none'
  /** Both sides removed the document. */
  | 'both-deleted'
  /** Deleted in git, unchanged in Linear: the document goes to trash. */
  | 'git-deleted'
  /** Removed in Linear, unchanged in git: the file is removed. */
  | 'linear-deleted'
  /** Deleted in git, changed in Linear: Linear's version stays. */
  | 'git-deleted-linear-changed'
  /** Removed in Linear, changed in git: the document is restored. */
  | 'linear-deleted-git-changed'
  /** Renamed in git only: both the rename and any edits apply. */
  | 'git-renamed'
  /** Renamed in Linear only: both the rename and any edits apply. */
  | 'linear-renamed'
  /** Both renamed to the same path. */
  | 'same-rename'
  /** Renamed differently on both sides: the git path wins. */
  | 'different-renames';

/**
 * Linear steps for the cycle to run, in this order: restore or create, then
 * retitle, write and comment. Each is one independent Linear call.
 */
export interface LinearSteps {
  /** Take the same document out of trash, or back into its mapped place. */
  restore: boolean;
  /** Create a new document: the old one is gone for good. */
  create: boolean;
  /** Move the document to trash. */
  trash: boolean;
  /** Set the title and place from the result path. */
  retitle: boolean;
  /** Write the result's body. */
  write: boolean;
  /** A neutral comment for the document, when Linear's title was set back. */
  comment?: string;
}

/** What happens to the file on the tracked branch, through the sync pull request. */
export type GitStep = 'none' | 'restore' | 'move' | 'delete';

/**
 * Summary codes, one per rule: a change beat a delete; a rename and an
 * edit both applied; the tracked branch's path won over a different Linear
 * rename.
 */
export type StructuralCode = 'edit-wins-delete' | 'rename-and-edit' | 'git-path-wins';

export interface StructuralSummary {
  code: StructuralCode;
  /** One line naming paths and the case, never content. */
  text: string;
}

export interface StructuralResult {
  kind: StructuralKind;
  /** The document's path after the run, or null when it is removed on both sides. */
  path: string | null;
  /** The file text after the run, or null when it is removed. */
  text: string | null;
  /** Conflicts in `text`, new or already there, marked with the conflict marker paragraphs. */
  conflicts: Conflict[];
  linear: LinearSteps;
  git: GitStep;
  /**
   * The summary entry when a rule decided a structural conflict. Null where
   * none had to: no change, a plain delete, both deleted, one side renamed
   * with no edit on the other, or the same rename on both sides; the
   * ordinary run summary reports those as deletes and moves.
   */
  summary: StructuralSummary | null;
}

export const RETITLED_COMMENT =
  'The title was set back because the file was renamed in git at the same time. Rename it again to change it.';

const NO_LINEAR_STEPS: LinearSteps = { restore: false, create: false, trash: false, retitle: false, write: false };

// Line endings are serialization, not edits (as in mergeMarkdown), and
// paths compare in NFC, so a decomposed file name is not a rename.
function lf(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

function body(text: string): string {
  return lf(splitFile(text).body);
}

function samePath(a: string, b: string): boolean {
  return a.normalize('NFC') === b.normalize('NFC');
}

function edited(version: Version, base: Version): boolean {
  return lf(version.text) !== lf(base.text);
}

function renamed(version: Version, base: Version): boolean {
  return !samePath(version.path, base.path);
}

function changed(version: Version, base: Version): boolean {
  return edited(version, base) || renamed(version, base);
}

function summary(code: StructuralCode, text: string, conflicts: readonly Conflict[]): StructuralSummary {
  if (conflicts.length === 1) text += '; 1 text conflict is marked in the document';
  else if (conflicts.length > 1) text += `; ${conflicts.length} text conflicts are marked in the document`;
  return { code, text };
}

/**
 * Resolves one document whose two sides may have deleted or renamed it.
 * Pure apart from mergeMarkdown's temporary files: it reads no repository
 * and calls no service. Requires Git on PATH.
 */
export async function resolveStructural(input: StructuralInput): Promise<StructuralResult> {
  const { base, git, linear } = input;

  if (git === null && linear === null) {
    return { kind: 'both-deleted', path: null, text: null, conflicts: [], linear: { ...NO_LINEAR_STEPS }, git: 'none', summary: null };
  }

  if (git === null) {
    const side = linear as Version;
    if (!changed(side, base)) {
      return { kind: 'git-deleted', path: null, text: null, conflicts: [], linear: { ...NO_LINEAR_STEPS, trash: true }, git: 'none', summary: null };
    }
    const conflicts = detectConflicts(side.text);
    return {
      kind: 'git-deleted-linear-changed',
      path: side.path,
      text: side.text,
      conflicts,
      linear: { ...NO_LINEAR_STEPS },
      git: 'restore',
      summary: summary('edit-wins-delete',
        `${side.path}: deleted in git but changed in Linear; the document is kept and its file comes back through the sync pull request`, conflicts),
    };
  }

  if (linear === null) {
    if (!changed(git, base)) {
      return { kind: 'linear-deleted', path: null, text: null, conflicts: [], linear: { ...NO_LINEAR_STEPS }, git: 'delete', summary: null };
    }
    const gone = input.linearGone === true;
    const conflicts = detectConflicts(git.text);
    return {
      kind: 'linear-deleted-git-changed',
      path: git.path,
      text: git.text,
      conflicts,
      // A restore keeps the document's comments exactly as they were; the
      // run summary, not a new comment, reports it.
      linear: gone
        ? { ...NO_LINEAR_STEPS, create: true, write: true }
        : { ...NO_LINEAR_STEPS, restore: true, retitle: true, write: true },
      git: 'none',
      summary: summary('edit-wins-delete', gone
        ? `${git.path}: deleted in Linear but changed in git; the document was gone from Linear, so a new one was created with the git text and its old comments are lost`
        : `${git.path}: deleted in Linear but changed in git; the document is restored with the git text`, conflicts),
    };
  }

  const gitRenamed = renamed(git, base);
  const linearRenamed = renamed(linear, base);
  const merged = await mergeMarkdown(base.text, git.text, linear.text);
  const path = gitRenamed ? git.path : linear.path;
  const write = body(merged.text) !== body(linear.text);
  const result = (kind: StructuralKind, steps: Partial<LinearSteps>, gitStep: GitStep, entry: [StructuralCode, string] | null): StructuralResult => ({
    kind,
    path,
    text: merged.text,
    conflicts: merged.conflicts,
    linear: { ...NO_LINEAR_STEPS, write, ...steps },
    git: gitStep,
    summary: entry === null ? null : summary(entry[0], entry[1], merged.conflicts),
  });

  if (!gitRenamed && !linearRenamed) return result('none', {}, 'none', null);
  if (gitRenamed && !linearRenamed) {
    return result('git-renamed', { retitle: true }, 'none', edited(linear, base)
      ? ['rename-and-edit', `${base.path} → ${path}: renamed in git and edited in Linear; both applied`]
      : null);
  }
  if (!gitRenamed) {
    return result('linear-renamed', {}, 'move', edited(git, base)
      ? ['rename-and-edit', `${base.path} → ${path}: renamed in Linear and edited in git; both applied`]
      : null);
  }
  if (samePath(git.path, linear.path)) return result('same-rename', {}, 'none', null);
  return result('different-renames', { retitle: true, comment: RETITLED_COMMENT }, 'none', ['git-path-wins',
    `${base.path}: renamed to ${git.path} in git and to ${linear.path} in Linear; the git path wins and the Linear title is set back`]);
}

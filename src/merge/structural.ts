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
  /** Linear no longer has the document at all, so it cannot be restored. */
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
  /** A neutral comment for the document, when Linear's own change was undone. */
  comment?: string;
}

/** What happens to the file on the tracked branch, through the sync pull request. */
export type GitStep = 'none' | 'restore' | 'move' | 'delete';

export interface StructuralResult {
  kind: StructuralKind;
  /** The document's path after the run, or null when it is removed on both sides. */
  path: string | null;
  /** The file text after the run, or null when it is removed. */
  text: string | null;
  /** Text conflicts in `text`, marked with the conflict marker paragraphs. */
  conflicts: Conflict[];
  linear: LinearSteps;
  git: GitStep;
  /** One line for the run summary naming paths and the case, never content; null when nothing structural happened. */
  summary: string | null;
}

export const RESTORED_COMMENT =
  'Restored: this document was edited in git after it was deleted here. Delete it again if it is no longer needed.';
export const RETITLED_COMMENT =
  'The title was set back because the file was renamed in git at the same time. Rename it again to change it.';

const NO_LINEAR_STEPS: LinearSteps = { restore: false, create: false, trash: false, retitle: false, write: false };

function body(text: string): string {
  return splitFile(text).body;
}

function edited(version: Version, base: Version): boolean {
  return version.text !== base.text;
}

function renamed(version: Version, base: Version): boolean {
  return version.path !== base.path;
}

function changed(version: Version, base: Version): boolean {
  return edited(version, base) || renamed(version, base);
}

function conflictNote(conflicts: readonly Conflict[]): string {
  if (conflicts.length === 0) return '';
  return conflicts.length === 1 ? '; 1 text conflict is marked in the document' : `; ${conflicts.length} text conflicts are marked in the document`;
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
    return {
      kind: 'git-deleted-linear-changed',
      path: side.path,
      text: side.text,
      conflicts: [],
      linear: { ...NO_LINEAR_STEPS },
      git: 'restore',
      summary: `${side.path}: deleted in git but changed in Linear; the document is kept and its file comes back through the sync pull request`,
    };
  }

  if (linear === null) {
    if (!changed(git, base)) {
      return { kind: 'linear-deleted', path: null, text: null, conflicts: [], linear: { ...NO_LINEAR_STEPS }, git: 'delete', summary: null };
    }
    const gone = input.linearGone === true;
    return {
      kind: 'linear-deleted-git-changed',
      path: git.path,
      text: git.text,
      conflicts: [],
      linear: gone
        ? { ...NO_LINEAR_STEPS, create: true, write: true, comment: RESTORED_COMMENT }
        : { ...NO_LINEAR_STEPS, restore: true, retitle: true, write: true, comment: RESTORED_COMMENT },
      git: 'none',
      summary: gone
        ? `${git.path}: deleted in Linear but changed in git; the document was gone from Linear, so a new one was created with the git text and its old comments are lost`
        : `${git.path}: deleted in Linear but changed in git; the document is restored with the git text`,
    };
  }

  const gitRenamed = renamed(git, base);
  const linearRenamed = renamed(linear, base);
  const merged = await mergeMarkdown(base.text, git.text, linear.text);
  const path = gitRenamed ? git.path : linear.path;
  const write = body(merged.text) !== body(linear.text);
  const result = (kind: StructuralKind, steps: Partial<LinearSteps>, gitStep: GitStep, summary: string | null): StructuralResult => ({
    kind,
    path,
    text: merged.text,
    conflicts: merged.conflicts,
    linear: { ...NO_LINEAR_STEPS, write, ...steps },
    git: gitStep,
    summary: summary === null ? null : summary + conflictNote(merged.conflicts),
  });

  if (!gitRenamed && !linearRenamed) return result('none', {}, 'none', null);
  if (gitRenamed && !linearRenamed) {
    return result('git-renamed', { retitle: true }, 'none', edited(linear, base)
      ? `${base.path} → ${path}: renamed in git and edited in Linear; both applied`
      : null);
  }
  if (!gitRenamed) {
    return result('linear-renamed', {}, 'move', edited(git, base)
      ? `${base.path} → ${path}: renamed in Linear and edited in git; both applied`
      : null);
  }
  if (git.path === linear.path) return result('same-rename', {}, 'none', null);
  return result('different-renames', { retitle: true, comment: RETITLED_COMMENT }, 'none',
    `${base.path}: renamed to ${git.path} in git and to ${linear.path} in Linear; the git path wins and the Linear title is set back`);
}

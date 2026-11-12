// Every code a run can report, one table per kind: in its last line, its
// `code` output, its job summary and its run report. The modules type their
// code fields with the unions derived from these tables, so a code exists
// only once it is in a table. docs/troubleshooting.md explains each code;
// its test reads these tables. The `lint` rules are in `src/format/rules.ts`.

import { type LintRule } from './format/rules.ts';

/** The setup check's items. */
export const CHECK_NAMES = [
  'linear-credentials',
  'github-access',
  'github-app',
  'merge-commits',
  'linear-format-hook',
  'annotations',
  'annotation-targets',
  'left-out-files',
  'security-hooks',
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/** Why a run stopped before writing anything. */
export const FAILURE_CODES = [
  'linear-credential-failed',
  'github-credential-failed',
  'missing-permission',
  'github-app-not-found',
  'merge-commits-required',
  'linear-format-hook-required',
  'invalid-annotation',
  'no-annotations',
  'linear-teams-not-visible',
  'annotation-target-not-found',
  'annotation-target-ambiguous',
  'annotation-target-shared',
  'initial-sync-required',
  'initial-pull-request-pending',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Why a folder's annotation cannot be used. */
export const ANNOTATION_PROBLEM_KINDS = ['invalid-annotation', 'project-without-team', 'nested-team', 'nested-project'] as const;
export type AnnotationProblemKind = (typeof ANNOTATION_PROBLEM_KINDS)[number];

/** Why a `.md` file is not synchronized at all. */
export const UNSYNCED_REASONS = ['outside-annotations', 'not-a-regular-file', 'binary', 'stored-in-lfs'] as const;
export type UnsyncedReason = (typeof UNSYNCED_REASONS)[number];

/** Why the initial sync's plan or the sync leaves a mapped file out, besides the `lint` rules. */
export const LEFT_OUT_RULES = ['duplicate-title', 'title-too-long'] as const;
export type LeftOutRule = (typeof LEFT_OUT_RULES)[number];

/** Why an initial sync to Linear leaves a document out while writing it. */
export const LEFT_OUT_AT_WRITE_RULES = ['content-too-long', 'upload-too-large', 'upload-unreadable'] as const;
export type LeftOutAtWriteRule = (typeof LEFT_OUT_AT_WRITE_RULES)[number];

/** Every rule a synchronized file can be left out by, in a plan or a sync. */
export type FileLeftOutRule = LintRule | UnsyncedReason | LeftOutRule | LeftOutAtWriteRule;

/** Why an initial sync from Linear leaves a file out of its record, or keeps the tracked one. */
export const RECORD_LEFT_OUT_RULES = ['download-failed', 'front-matter-boundary', 'title-not-a-path', 'security-hook', 'security-unchecked'] as const;
export type RecordLeftOutRule = (typeof RECORD_LEFT_OUT_RULES)[number];

/** Why the sync's capture leaves a Linear document out. */
export const CAPTURE_LEFT_OUT_RULES = ['capture-translation', 'download-retry', 'security-unchecked'] as const;
export type CaptureLeftOutRule = (typeof CAPTURE_LEFT_OUT_RULES)[number];

/** The rule a file name read from Linear follows. */
export const PATH_RULES = ['percent-encode-unsafe-segments'] as const;
export type PathRule = (typeof PATH_RULES)[number];

/** A change the capture took from Linear but could not write back: a person shortens it. */
export const WRITE_BACK_WARNING_CODES = ['linear-content-too-large-to-write-back'] as const;
export type WriteBackWarningCode = (typeof WRITE_BACK_WARNING_CODES)[number];

/** Rules a merge of a Linear change and a tracked-branch change decided by. */
export const STRUCTURAL_CODES = ['edit-wins-delete', 'rename-and-edit', 'git-path-wins'] as const;
export type StructuralCode = (typeof STRUCTURAL_CODES)[number];

/** Why the sync did not write a document. */
export const SKIP_REASONS = ['edited-in-linear', 'missing-in-linear', 'conflict', 'renamed-to-unwritable', 'suspended'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** Why the sync's capture did not finish. */
export const CAPTURE_CODES = ['state-moved', 'stopped', 'linear-failed'] as const;
export type CaptureCode = (typeof CAPTURE_CODES)[number];

/** Why a write to Linear, by the sync or an initial sync, did not finish. */
export const WRITE_CODES = ['stopped', 'write-failed', 'state-moved', 'container-cap'] as const;
export type WriteCode = (typeof WRITE_CODES)[number];

/** Why an initial sync from Linear did not finish recording. */
export const RECORD_CODES = ['stopped', 'state-moved', 'pull-request-failed', 'sync-branch-changed'] as const;
export type RecordCode = (typeof RECORD_CODES)[number];

/** Why the sync pull request step did not finish. */
export const PULL_REQUEST_CODES = ['conflict', 'merge-refused', 'merge-blocked', 'initial-pull-request-pending', 'state-moved', 'github-failed'] as const;
export type PullRequestCode = (typeof PULL_REQUEST_CODES)[number];

/** A sync run is partial because it held a removal it could not confirm. */
export const HELD_CODES = ['removal-held'] as const;
export type HeldCode = (typeof HELD_CODES)[number];

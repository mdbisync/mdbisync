export { mergeMarkdown } from './merge.ts';
export type { MergeResult } from './merge.ts';
export { detectConflicts, MARKERS } from './markers.ts';
export type { Conflict } from './markers.ts';
export { RETITLED_COMMENT, resolveStructural } from './structural.ts';
export type {
  GitStep, LinearSteps, StructuralCode, StructuralInput, StructuralKind, StructuralResult, StructuralSummary, Version,
} from './structural.ts';

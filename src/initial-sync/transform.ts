// The step between a file's body and the content written to Linear. The
// file's body is what the sync sends, front matter removed; a transform
// rewrites parts of it that mean something else in Linear, such as relative
// links to images, attachments or other synchronized documents.
//
// Transforms run in order, one document at a time, just before the write.
// A transform may make requests of its own (an upload); it must not write the
// document itself.

import { type LinearClient } from '../linear/index.ts';
import { type Git, type Oid, type UploadMap } from '../state/index.ts';
import { type InitialSyncPlan } from './plan.ts';

export interface TransformInput {
  /** The file's path in the repository. */
  path: string;
  /** The text to send so far. */
  body: string;
}

/** Why a document cannot be written as it is; it is then left out and listed with the rule. */
export class LeaveOutError extends Error {
  readonly rule: string;

  constructor(rule: string, message: string) {
    super(message);
    this.name = 'LeaveOutError';
    this.rule = rule;
  }
}

export interface BodyTransform {
  /** A short name for reports. */
  readonly name: string;
  /** Called once before the first document. */
  prepare?(context: TransformContext): Promise<void>;
  /** Returns the new body; throws `LeaveOutError` to leave this document out. */
  apply(input: TransformInput): Promise<string>;
  /**
   * The inverse, for what Linear stores: maps the content back to the
   * file's form (an asset URL back to its relative path), so the recorded
   * file equals the tracked one when Linear kept the text. Makes no requests.
   */
  restore(input: TransformInput): string;
}

/** What a transform may use. */
export interface TransformContext {
  git: Git;
  /** The tracked branch's commit, whose files the documents come from. */
  tracked: Oid;
  linear: LinearClient;
  plan: InitialSyncPlan;
  /**
   * Path → id of every document the run writes: a matched document's id, and
   * for a new one the id the run will create it with, chosen before the first
   * write so a document can link one created later in the same run.
   */
  documentIds: ReadonlyMap<string, string>;
  /**
   * The upload cache, read from the `uploads` state ref. A transform adds
   * to it as it uploads; the run pushes it with the document ids, so an
   * upload is recorded no later than the document that uses it.
   */
  uploads: UploadMap;
}

/** Runs the transforms in order. */
export async function transformBody(transforms: readonly BodyTransform[], path: string, body: string): Promise<string> {
  let current = body;
  for (const transform of transforms) current = await transform.apply({ path, body: current });
  return current;
}

/** Runs the transforms' inverses in reverse order. */
export function restoreBody(transforms: readonly BodyTransform[], path: string, content: string): string {
  let current = content;
  for (const transform of [...transforms].reverse()) current = transform.restore({ path, body: current });
  return current;
}

// The step between a file's body and the content written to Linear. The
// file's body is what the sync sends, front matter removed; a transform
// rewrites parts of it that mean something else in Linear, such as relative
// links to images, attachments or other synchronized documents.
//
// Transforms run in order, one document at a time, just before the write.
// A transform may make requests of its own (an upload); it must not write the
// document itself.

import { fixText, sameMarkdown } from '../format/index.ts';
import { type LinearClient } from '../linear/index.ts';
import { type Git, type Oid, type UploadMap } from '../state/index.ts';
import { type InitialSyncPlan } from './plan.ts';

export interface TransformInput {
  /** The file's path in the repository. */
  path: string;
  /** The text to send so far. */
  body: string;
}

/** What a transform's inverse gets: Linear's content so far, and whether Linear stored the text it was sent. */
export interface RestoreInput {
  path: string;
  body: string;
  /**
   * Linear stored exactly what was sent. When false, Linear reformatted the
   * document, and `restoreBody` puts the whole restored text in Linear's form.
   */
  kept: boolean;
}

/** Why a document cannot be written as it is; it is then left out and listed with the rule. */
export class LeaveOutError extends Error {
  readonly rule: string;
  /** The files that caused it, by repository path (a file over the upload limit). */
  readonly files: readonly string[];

  constructor(rule: string, message: string, files: readonly string[] = []) {
    super(message);
    this.name = 'LeaveOutError';
    this.rule = rule;
    this.files = files;
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
  restore(input: RestoreInput): string;
}

/** What a transform may use. */
export interface TransformContext {
  git: Git;
  /** The tracked branch's commit, whose files the documents come from. */
  tracked: Oid;
  linear: LinearClient;
  plan: InitialSyncPlan;
  /**
   * The upload cache, read from the `uploads` state ref. A transform adds
   * to it as it uploads; the run pushes it with the document ids, so an
   * upload is recorded no later than the document that uses it.
   */
  uploads: UploadMap;
  /**
   * The Linear document id of every path the run writes or keeps: a matched
   * document's id, or the id a new document will be created with. Known
   * before the first write, and the same when a stopped run resumes.
   */
  documentIds: ReadonlyMap<string, string>;
}

/** Runs the transforms in order. */
export async function transformBody(transforms: readonly BodyTransform[], path: string, body: string): Promise<string> {
  let current = body;
  for (const transform of transforms) current = await transform.apply({ path, body: current });
  return current;
}

/**
 * Linear's content in the file's form: the transforms' inverses, in reverse
 * order, put back each link as the file spelled it. When Linear stored the
 * body it was sent, that is the file as it was. When Linear reformatted it,
 * the restored text is put in Linear's form as a whole, so the file's
 * spellings, placed into reformatted text, become Linear's spellings too
 * (`<a b.png>` as `a%20b.png`), and a later run finds the document holding
 * the file.
 */
export function restoreBody(transforms: readonly BodyTransform[], path: string, content: string, sent: string): string {
  // Linear's own spelling of the same document (a final newline, an escape
  // it adds) is not a reformat: the file keeps its text.
  const kept = sameMarkdown(content, sent);
  let current = sent;
  if (!kept) current = content;
  for (const transform of [...transforms].reverse()) current = transform.restore({ path, body: current, kept });
  return kept ? current : fixText(current);
}

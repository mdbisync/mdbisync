// The suspended mark in Linear: every document of a suspended batch shows
// the red cross with one comment that says which check failed, links to its
// run and quotes the check's annotations on that document's file. The mark
// is set after the push that records the episodes, its comment is edited
// when a later failure reads differently, and both clear at release.
//
// Linear's request budget is the scarce one: a mark set or cleared costs a
// document two requests (icon, comment), a changed comment one, and no
// document is read for it (the capture's listing holds icon, color and the
// comment target). At most `HOLD_MARK_LIMIT` documents change per run.

import { createHash } from 'node:crypto';
import { LinearError, LinearStoppedError, type LinearClient, type LinearDocument } from '../linear/index.ts';
import { type CheckAnnotation, type CheckFailure, type GitHubRepository, PullRequestError, readAnnotations } from '../pull-request/index.ts';
import { type RunContext } from '../run/preflight.ts';
import { type HoldNotice, type IdEntry, type Oid, type StateConfig, type StateSnapshot, pushAtomic, readIds, stateRef } from '../state/index.ts';
import { MARKS } from './marks.ts';
import { commitLaneIds } from './suspended.ts';

/** The most documents whose suspended mark or comment changes in one run; the rest follow in later runs. */
export const HOLD_MARK_LIMIT = 50;
/** The most annotations quoted per check; the rest are counted. */
export const ANNOTATIONS_PER_CHECK = 10;
/** The longest annotation line, title and message together. */
export const ANNOTATION_LENGTH = 200;
/** A message holding this many characters of the document's own text in a row is not quoted. */
export const QUOTE_RUN = 12;

export const HOLD_FAILED = 'Changes to this document are on hold: a check failed on the pull request that brings them to Git. Other documents keep syncing.';
export const HOLD_TIMED_OUT = 'Changes to this document are on hold: a check did not finish in time on the pull request that brings them to Git. Other documents keep syncing.';
export const HOLD_FOOTER = 'The failure may come from another document of the same change. If a line above names this document, edit it here to try again; the hold also clears when the check is fixed in Git.';

/** What a suspended head's checks said: the failed commit, its failed checks and the ones past the deadline. */
export interface HoldFailure {
  head: Oid;
  checks: CheckFailure[];
  /** Checks still pending at the deadline (set by the deadline's caller). */
  timedOut?: string[];
}

export type HoldClient = Pick<LinearClient, 'updateDocument' | 'ensureDocumentComment' | 'updateDocumentComment' | 'resolveComment'>;

export interface HoldMarksOptions {
  config: StateConfig;
  /** The state refs as the lane left them; `ids` moves with this step's pushes. */
  state: StateSnapshot;
  /** The capture's documents by id: metadata for every listed document. */
  documents: ReadonlyMap<string, LinearDocument>;
  github: GitHubRepository;
  /** The failure the comments describe, when this run read one. */
  failure?: HoldFailure | undefined;
  linear: HoldClient;
  limit?: number;
}

export interface HoldMarksResult {
  /** Documents whose suspended mark or comment changed in Linear this run. */
  set: string[];
  updated: string[];
  cleared: string[];
  /** Documents left for a later run by the limit. */
  deferred: number;
  /** Suspended documents in Linear's trash or archived: they hold no mark. */
  removed: string[];
  code?: 'state-moved' | 'linear-failed' | 'github-failed';
  failure?: { operation: string };
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** A failure's identity: its checks, their runs and the ones past the deadline. A new run of a check is a new failure. */
const failureKey = (failure: HoldFailure) => sha256(JSON.stringify({ checks: failure.checks, timedOut: failure.timedOut ?? [] }));

/** One line of plain text, Markdown's own characters escaped, so a check cannot add links or images. */
function plainLine(text: string, limit: number): string {
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const points = [...line];
  const cut = points.length > limit ? `${points.slice(0, limit - 1).join('')}…` : line;
  return cut.replace(/[\\`*_[\]<>|~!]/g, (character) => `\\${character}`);
}

function checkName(name: string): string {
  const points = [...name.replace(/[`\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()];
  return points.length > 100 ? `${points.slice(0, 99).join('')}…` : points.join('') || 'unnamed check';
}

const collapse = (text: string) => text.replace(/\s+/g, ' ');

/** Whether `text` repeats a run of `QUOTE_RUN` characters of the document, compared with white space collapsed. */
export function quotesDocument(text: string, runs: ReadonlySet<string>): boolean {
  const points = [...collapse(text)];
  for (let start = 0; start + QUOTE_RUN <= points.length; start += 1) {
    if (runs.has(points.slice(start, start + QUOTE_RUN).join(''))) return true;
  }
  return false;
}

/** Every run of `QUOTE_RUN` characters of a document's text. */
export function documentRuns(text: string): Set<string> {
  const points = [...collapse(text)];
  const runs = new Set<string>();
  for (let start = 0; start + QUOTE_RUN <= points.length; start += 1) runs.add(points.slice(start, start + QUOTE_RUN).join(''));
  return runs;
}

/** One annotation as a comment line: its line and text, or only its line (and title) when the text quotes the document. */
function annotationLine(annotation: CheckAnnotation, runs: ReadonlySet<string>): string {
  const title = annotation.title !== undefined && !quotesDocument(annotation.title, runs) ? annotation.title : undefined;
  const message = quotesDocument(annotation.message, runs) ? undefined : annotation.message;
  const text = [title, message].filter((part) => part !== undefined).join(': ');
  const where = annotation.line > 0 ? `Line ${annotation.line}` : 'File';
  return text === '' ? `${where}.` : `${where}: ${plainLine(text, ANNOTATION_LENGTH)}`;
}

/**
 * The comment of a suspended document. `annotations` are the failed check
 * runs' annotations on this document's path; `text` is the file the check
 * read, for the quote rule.
 */
export function holdComment(checks: readonly CheckFailure[], timedOut: readonly string[], annotations: ReadonlyMap<string, readonly CheckAnnotation[]>, text: string): string {
  let runs: Set<string> | undefined;
  const lines: string[] = [];
  for (const check of checks) {
    const name = `Check \`${checkName(check.name)}\``;
    lines.push(check.url === undefined ? `- ${name}.` : `- ${name}: [run](${check.url})`);
    const own = annotations.get(check.name) ?? [];
    if (own.length > 0) runs ??= documentRuns(text);
    for (const annotation of own.slice(0, ANNOTATIONS_PER_CHECK)) lines.push(`  - ${annotationLine(annotation, runs as Set<string>)}`);
    if (own.length > ANNOTATIONS_PER_CHECK) lines.push(`  - and ${own.length - ANNOTATIONS_PER_CHECK} more.`);
  }
  for (const name of timedOut) lines.push(`- Check \`${checkName(name)}\` did not finish in time.`);
  const lead = checks.length === 0 && timedOut.length > 0 ? HOLD_TIMED_OUT : HOLD_FAILED;
  return `${lead}\n\n${lines.join('\n')}\n\n${HOLD_FOOTER}`;
}

type Work =
  | { kind: 'clear'; path: string; entry: IdEntry; document: LinearDocument }
  | { kind: 'repaint'; path: string; entry: IdEntry; document: LinearDocument }
  | { kind: 'set' | 'update'; path: string; entry: IdEntry; document: LinearDocument; body: string; failure?: string; previous?: HoldNotice };

/**
 * Set, edit and clear the suspended marks the id map asks for. Runs after
 * the lane's push: a suspended episode's `noticeId` is durable before its
 * comment is posted, and the saved icon is pushed before the mark replaces
 * it. Runs that stop part way leave the rest to the next run.
 */
export async function reconcileHoldMarks(context: RunContext, options: HoldMarksOptions): Promise<HoldMarksResult> {
  const { git } = context;
  const result: HoldMarksResult = { set: [], updated: [], cleared: [], deferred: 0, removed: [] };
  const ids = await readIds(git, options.state.ids);
  const limit = options.limit ?? HOLD_MARK_LIMIT;
  const failure = options.failure;

  // Annotations are read once per failed check run, and only when a comment is to be written.
  let annotations: Map<string, CheckAnnotation[]> | undefined;
  const readAll = async (): Promise<Map<string, CheckAnnotation[]>> => {
    if (annotations !== undefined) return annotations;
    annotations = new Map();
    for (const check of failure?.checks ?? []) {
      if (check.checkRunId !== undefined) annotations.set(check.name, await readAnnotations(options.github, check.checkRunId));
    }
    return annotations;
  };
  const bodyOf = async (path: string, entry: IdEntry): Promise<{ body: string; failure?: string }> => {
    if (failure === undefined) {
      // No failure read this run (the head is still checking): the episode's check names, without links.
      const checks = (entry.suspended?.checks ?? []).map((name) => ({ name }));
      return { body: holdComment(checks, [], new Map(), '') };
    }
    const all = await readAll();
    const own = new Map([...all].map(([name, list]) => [name, list.filter((annotation) => annotation.path === path)] as const));
    const needsText = [...own.values()].some((list) => list.length > 0);
    const shown = needsText ? await git.run(['show', `${failure.head}:${path}`], { okCodes: [0, 128] }) : undefined;
    const text = shown?.code === 0 ? shown.stdout.toString('utf8') : '';
    // A file the check read but this commit lacks cannot be compared: its messages are not quoted.
    if (needsText && shown?.code !== 0) for (const [name, list] of own) own.set(name, list.map(({ message: _message, ...rest }) => ({ ...rest, message: '' })));
    return { body: holdComment(failure.checks, failure.timedOut ?? [], own, text), failure: failureKey(failure) };
  };

  const work: Work[] = [];
  const quiet: Array<{ path: string; entry: IdEntry }> = [];
  try {
    for (const [path, entry] of ids) {
      const hold = entry.saved?.hold;
      const episode = entry.suspended;
      if (hold === undefined && episode === undefined) continue;
      const document = options.documents.get(entry.id);
      if (document === undefined || document.trashed || document.archivedAt !== null) {
        if (episode !== undefined) result.removed.push(path);
        continue;
      }
      if (episode === undefined) {
        work.push({ kind: 'clear', path, entry, document });
        continue;
      }
      if (hold?.id !== episode.noticeId || !hold.posted) {
        // An earlier episode's comment that was never cleared (released and suspended again in between) is resolved first.
        const previous = hold !== undefined && hold.id !== episode.noticeId && hold.posted ? { previous: hold } : {};
        work.push({ kind: 'set', path, entry, document, ...previous, ...(await bodyOf(path, entry)) });
        continue;
      }
      // The cross was taken off (the document came back from the trash, or a person changed its icon): put it back.
      const repaint = document.icon !== MARKS.suspended.icon || document.color !== MARKS.suspended.color;
      if (failure === undefined || hold.failure === failureKey(failure)) {
        if (repaint) work.push({ kind: 'repaint', path, entry, document });
        continue;
      }
      const next = await bodyOf(path, entry);
      if (sha256(next.body) === hold.bodyHash) quiet.push({ path, entry: withHold(entry, { ...hold, ...(next.failure === undefined ? {} : { failure: next.failure }) }) });
      else work.push({ kind: 'update', path, entry, document, ...next });
    }
  } catch (error) {
    if (error instanceof PullRequestError) return { ...result, code: 'github-failed' };
    throw error;
  }
  // Clearing first: a released batch's documents get their own icons back before new holds take the budget.
  const order = { clear: 0, set: 1, update: 2, repaint: 3 } as const;
  work.sort((a, b) => order[a.kind] - order[b.kind]);
  const chosen = work.slice(0, limit);
  result.deferred = work.length - chosen.length;

  let expected = options.state.ids;
  const persist = async () => {
    const next = await commitLaneIds(context, expected, ids, 'Sync: suspended document marks');
    if (next === expected) return true;
    const pushed = await pushAtomic(git, options.config, [{ ref: stateRef(options.config, 'ids'), expected, next }]);
    if (!pushed.ok) return false;
    expected = next;
    options.state.ids = next;
    return true;
  };

  // The saved decoration and the pending comment are durable before any mark replaces them.
  for (const { path, entry } of quiet) ids.set(path, entry);
  for (const item of chosen) if (item.kind === 'set') {
    const saved = item.entry.saved ?? { icon: item.document.icon, color: item.document.color };
    const hold: HoldNotice = { id: (item.entry.suspended as NonNullable<IdEntry['suspended']>).noticeId, bodyHash: sha256(item.body), posted: false, ...(item.failure === undefined ? {} : { failure: item.failure }) };
    item.entry = { ...item.entry, saved: { ...saved, hold } };
    ids.set(item.path, item.entry);
  }
  if (!(await persist())) return { ...result, code: 'state-moved' };

  const { linear } = options;
  try {
    for (const item of chosen) {
      const { document, path } = item;
      if (item.kind === 'clear') {
        const hold = item.entry.saved?.hold as HoldNotice;
        if (hold.posted) await linear.resolveComment(hold.id);
        const { hold: _hold, ...saved } = item.entry.saved as NonNullable<IdEntry['saved']>;
        // A conflict or blocked notice still stands: its own mark comes back. Otherwise the document's own decoration.
        const mark = saved.notice === undefined ? { icon: saved.icon, color: saved.color } : MARKS[saved.notice.kind];
        if (document.icon !== mark.icon || document.color !== mark.color) await linear.updateDocument(document.id, mark);
        const { saved: _saved, ...rest } = item.entry;
        ids.set(path, saved.notice === undefined ? rest : { ...rest, saved });
        result.cleared.push(path);
        continue;
      }
      if (item.kind === 'repaint') {
        await linear.updateDocument(document.id, MARKS.suspended);
        result.updated.push(path);
        continue;
      }
      if (!document.documentContentId) continue;
      const hold = item.entry.saved?.hold as HoldNotice;
      if (item.kind === 'set') {
        if (item.previous !== undefined) await linear.resolveComment(item.previous.id);
        const mark = MARKS.suspended;
        if (document.icon !== mark.icon || document.color !== mark.color) await linear.updateDocument(document.id, mark);
        // The id was chosen before the suspension's push and never posted by this sync: create it directly,
        // and a create Linear refuses because the id exists finds it and updates its text.
        await linear.ensureDocumentComment(document.documentContentId, item.body, hold.id, true, true);
        ids.set(path, withHold(item.entry, { ...hold, posted: true }));
        result.set.push(path);
      } else {
        if (document.icon !== MARKS.suspended.icon || document.color !== MARKS.suspended.color) await linear.updateDocument(document.id, MARKS.suspended);
        await linear.updateDocumentComment(hold.id, item.body);
        ids.set(path, withHold(item.entry, { ...hold, bodyHash: sha256(item.body), ...(item.failure === undefined ? {} : { failure: item.failure }) }));
        result.updated.push(path);
      }
    }
  } catch (error) {
    if (!(error instanceof LinearError)) throw error;
    result.code = 'linear-failed';
    result.failure = { operation: error.operation };
    if (error instanceof LinearStoppedError) result.failure = { operation: 'stopped' };
  }
  if (!(await persist())) result.code = 'state-moved';
  return result;
}

function withHold(entry: IdEntry, hold: HoldNotice): IdEntry {
  return { ...entry, saved: { ...(entry.saved as NonNullable<IdEntry['saved']>), hold } };
}

/** The number of documents whose suspended mark or comment changed: each may cost two Linear requests (I9). */
export function holdChanges(result: HoldMarksResult | undefined): number {
  return result === undefined ? 0 : result.set.length + result.updated.length + result.cleared.length;
}

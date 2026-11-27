// The format problems pull request: the files the sync leaves out for their
// Markdown, made visible. While any such file is on the tracked branch, one
// pull request from the sync's own branch holds what `fix` writes for them,
// and its description lists what `fix` leaves to a person. Each run brings it
// up to date and closes it once nothing is left. The sync never merges it: a
// person reviews the rewrite, and the next run after the merge writes the
// fixed files to Linear.

import { linkedFileCheck, lintInTree, lintText } from '../format/index.ts';
import { fixDocument } from '../format/command.ts';
import { type LintRule } from '../format/rules.ts';
import { type RepositoryMapping, loadMapping } from '../mapping/mapping.ts';
import { type GitHubRepository, PullRequestError, closePullRequest, ensurePullRequest, findOpenPullRequest, lastClosedPullRequest } from '../pull-request/index.ts';
import { type RunContext } from '../run/preflight.ts';
import { cell } from '../run/summary.ts';
import { message } from '../messages.ts';
import { type CommitIdentity, GitError, type Oid, type StateConfig, branchRef, commitTree, formatProblemsBranch, isAncestor, pushAtomic, readBlobs } from '../state/index.ts';

export const FORMAT_PROBLEMS_TITLE = 'Fix Markdown format problems';
export const FORMAT_PROBLEMS_MESSAGE = 'Fix Markdown format problems\n\nWhat mdbisync fix writes for the files the sync leaves out for their Markdown.';

/** A file the sync leaves out for its Markdown. */
export interface FormatProblemFile {
  path: string;
  /** `fix` rewrites the file in the pull request. */
  fixed: boolean;
  /** What lint reports of the file after `fix`: what `fix` leaves to a person. */
  findings: Array<{ line: number; rule: LintRule; message: string; holdsBack: boolean }>;
}

export interface FormatProblemsResult {
  files: FormatProblemFile[];
  /** The open format problems pull request after this run; null when there is none. */
  pullRequest: { number: number; url: string; opened: boolean; updated: boolean } | null;
  /** A person closed the pull request for the branch's current head without merging it: it stays closed until the tracked branch moves. */
  dismissed: number | null;
  /** The pull request this run closed, as no file is left out for its Markdown any more. */
  closed: number | null;
  /** The branch moved: the run pushed a new head. */
  branchMoved: boolean;
  /** Why the step did not finish: the branch moved under the run, or GitHub refused or failed a request or the push; the next run tries again. */
  code?: 'state-moved' | 'github-failed';
  error?: string;
}

/**
 * The files of a tracked tree that the sync leaves out for their Markdown,
 * with `fix`'s output: the mapped documents whose lint findings hold them
 * back, and the files whose titles collide, when lint finds something in
 * them. A colliding file is not rewritten: which of them is the document is
 * still the author's choice. `texts` holds the text of each path.
 */
export function formatProblems(mapping: Pick<RepositoryMapping, 'documents' | 'leftOut' | 'files'>, texts: ReadonlyMap<string, string>): Array<FormatProblemFile & { text: string }> {
  const problems: Array<FormatProblemFile & { text: string }> = [];
  const exists = (path: string) => linkedFileCheck(path, (file) => mapping.files.has(file));
  const candidates = [...mapping.documents.map((document) => ({ path: document.path, colliding: false })), ...mapping.leftOut.map((file) => ({ path: file.path, colliding: true }))]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const { path, colliding } of candidates) {
    const text = texts.get(path);
    if (text === undefined) continue;
    const holding = new Set(lintInTree(path, text, mapping.files).map(key));
    if (colliding) {
      const findings = lintText(path, text, { linkedFileExists: exists(path) });
      if (findings.length > 0) problems.push({ path, fixed: false, text, findings: findings.map((finding) => ({ ...findingOf(finding), holdsBack: holding.has(key(finding)) })) });
      continue;
    }
    if (holding.size === 0) continue;
    const fixed = fixDocument(path, text, exists(path));
    const held = new Set(lintInTree(path, fixed.text, mapping.files).map(key));
    problems.push({ path, fixed: fixed.text !== text, text: fixed.text, findings: fixed.findings.map((finding) => ({ ...findingOf(finding), holdsBack: held.has(key(finding)) })) });
  }
  return problems;
}

const key = (finding: { line: number; rule: string }): string => `${finding.line}:${finding.rule}`;
const findingOf = (finding: { line: number; rule: LintRule; message: string }) => ({ line: finding.line, rule: finding.rule, message: finding.message });

/** Characters the description's lists take at most, so it stays well within GitHub's limit of 65,536. */
const BODY_BUDGET = 60_000;

/** The pull request's description: what it holds, and each finding left to a person. */
export function formatProblemsBody(files: readonly FormatProblemFile[]): string {
  const fixed = files.filter((file) => file.fixed);
  const findings = files.flatMap((file) => file.findings.map((finding) => ({ path: file.path, ...finding })));
  const lines = [
    'The sync leaves these files out of Linear: their Markdown has constructs Linear would lose or alter. Their documents in Linear stay as they are until the files are fixed.',
    '',
    'The sync updates this pull request on every run, closes it when no file is left out for its Markdown, and never merges it. Once it is merged, the next sync run writes the fixed files to Linear. Closed without merging, it stays closed until the tracked branch changes.',
    '',
  ];
  let budget = BODY_BUDGET;
  /** Adds the rows that fit in the budget, and a line for those that do not. */
  const rows = (all: readonly string[], more: (left: number) => string) => {
    let shown = 0;
    for (const row of all) {
      if (row.length + 1 > budget) break;
      lines.push(row);
      budget -= row.length + 1;
      shown += 1;
    }
    if (shown < all.length) lines.push('', more(all.length - shown));
    lines.push('');
  };
  if (fixed.length > 0) {
    lines.push(`### Fixed by \`mdbisync fix\` (${fixed.length})`, '', 'Review the changes before merging.', '', '| File |', '| --- |');
    rows(fixed.map((file) => `| ${cell(file.path)} |`), (left) => `And ${left} more files: see the changes of this pull request.`);
  }
  if (findings.length > 0) {
    lines.push(`### Left for you to fix (${findings.length})`, '', '`mdbisync fix` cannot write these in a form Linear keeps. Fix them on the tracked branch.', '');
    lines.push('| File | Line | Rule | Holds the file back | What to do |', '| --- | --- | --- | --- | --- |');
    rows(findings.map((finding) => `| ${cell(finding.path)} | ${finding.line} | ${cell(finding.rule)} | ${finding.holdsBack ? 'yes' : 'no'} | ${cell(finding.message)} |`), (left) => `And ${left} more: run \`mdbisync lint\` on the files to see them all.`);
  }
  return lines.join('\n');
}

export interface FormatProblemsOptions {
  config: StateConfig;
  github: GitHubRepository;
  /** The mapping of the tracked branch's commit, when the run read it at that commit; read again otherwise. */
  mapping?: RepositoryMapping;
  identity?: CommitIdentity;
}

/**
 * Brings the format problems pull request up to date with the tracked branch:
 * opens or updates it while a file is left out for its Markdown, closes it
 * when none is. Its branch only moves forward: a new head is a commit on the
 * tracked branch, or a merge of the branch's head and the tracked branch,
 * whose tree is the tracked branch with `fix`'s rewrites.
 */
export async function formatProblemsPullRequest(context: RunContext, options: FormatProblemsOptions): Promise<FormatProblemsResult> {
  const { git } = context;
  // The tracked branch as this run leaves it: a released suspended batch can have moved it since the preflight.
  const tracked = context.fetched.tracked;
  const mapping = options.mapping ?? await loadMapping(git, tracked);
  const branch = formatProblemsBranch(options.config);
  const head = context.fetched.formatProblems ?? null;
  const candidates = [...mapping.documents, ...mapping.leftOut];
  const blobs = await readBlobs(git, candidates.map((file) => file.oid));
  const texts = new Map(candidates.map((file) => [file.path, (blobs.get(file.oid) as Buffer).toString('utf8')]));
  const problems = formatProblems(mapping, texts);
  const files = problems.map(({ text: _text, ...file }) => file);
  const result: FormatProblemsResult = { files, pullRequest: null, dismissed: null, closed: null, branchMoved: false };
  const target = { head: branch, base: options.config.trackedBranch };
  try {
    if (problems.length === 0) {
      // Without its branch, no pull request from it is open.
      if (head === null) return result;
      const open = await findOpenPullRequest(options.github, target.head, target.base);
      if (open !== null) {
        await closePullRequest(options.github, open.number);
        result.closed = open.number;
      }
      return result;
    }
    const changes = new Map(problems.filter((problem) => problem.fixed).map((problem) => [problem.path, problem.text]));
    const next = await nextHead(context, head, tracked, changes, options.identity ?? context.identity);
    if (next !== head) {
      let pushed: Awaited<ReturnType<typeof pushAtomic>>;
      try {
        pushed = await pushAtomic(git, options.config, [{ ref: branchRef(branch), expected: head, next }]);
      } catch (error) {
        // A push the remote did not answer (a lost connection, an outage): the next run pushes again.
        if (!(error instanceof GitError)) throw error;
        return { ...result, code: 'github-failed', error: message('github.no-answer', { action: message('github.pushing-format-problems') }) };
      }
      if (!pushed.ok) return pushed.reason === 'stale' ? { ...result, code: 'state-moved' } : { ...result, code: 'github-failed', error: pushed.refs.map((ref) => `${ref.ref}: ${ref.message}`).join('; ') };
      context.fetched.formatProblems = next;
      result.branchMoved = true;
    } else if (await findOpenPullRequest(options.github, target.head, target.base) === null) {
      // A person who closed the pull request for this head without merging it dismissed it: not opened again until the tracked branch moves.
      const closed = await lastClosedPullRequest(options.github, target.head, target.base);
      if (closed !== null && !closed.merged && closed.head === head) return { ...result, dismissed: closed.number };
    }
    const ensured = await ensurePullRequest(options.github, { ...target, title: FORMAT_PROBLEMS_TITLE, body: formatProblemsBody(files) });
    result.pullRequest = { number: ensured.pullRequest.number, url: ensured.pullRequest.url, opened: ensured.opened, updated: ensured.updated };
    return result;
  } catch (error) {
    if (!(error instanceof PullRequestError)) throw error;
    return { ...result, code: 'github-failed', error: error.message };
  }
}

/**
 * The branch's head that holds the tracked branch with `changes`. A head that
 * already holds the tracked branch stays, with any commit a CI job or a person
 * added to it: the rewrites depend only on the tracked branch. Otherwise a new
 * commit that only moves the branch forward: on the tracked branch alone when
 * the tracked branch holds the head (a merged pull request), else a merge of
 * the head and the tracked branch. A commit is made even when `changes`
 * change nothing, so the pull request can list what is left to a person.
 */
async function nextHead(context: RunContext, head: Oid | null, tracked: Oid, changes: ReadonlyMap<string, string>, identity: CommitIdentity): Promise<Oid> {
  const { git } = context;
  if (head !== null && head !== tracked && await isAncestor(git, tracked, head)) return head;
  const behind = head === null || await isAncestor(git, head, tracked);
  return commitTree(git, { parents: behind ? [tracked] : [head, tracked], base: tracked, changes, message: FORMAT_PROBLEMS_MESSAGE, identity, skipIfUnchanged: false });
}

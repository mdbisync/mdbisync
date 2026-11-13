// What a workflow run could write to the repository with, read from GitHub's
// own records of the run: the workflow file GitHub ran (at the run's commit)
// and the runner's log of the run. GitHub keeps no record of who pushed to a
// ref outside branches and tags (the sync's state refs), so for those refs
// the writer is proven through the run that moved them: a run whose job token
// cannot write contents, that hands its jobs no other secret, and whose every
// App token step minted a token for the harness's App can only have pushed
// as that App.

import { isMap, isScalar, isSeq, parseDocument, type Node } from 'yaml';
import { CANARY_SECRET, SANDBOX_NAMES } from './workflow-files.ts';

/** The step that mints the App's installation token in the templates. */
const APP_TOKEN_ACTION = 'actions/create-github-app-token@';

/**
 * The secrets a sandbox workflow may reference, upper-cased as GitHub
 * compares secret names without regard to case: the App's private key, the
 * Linear OAuth app, and the security canary's hook key. None is a GitHub
 * credential other than the App's key, which mints only that App's tokens.
 */
export const RUN_SECRETS: ReadonlySet<string> = new Set([
  ...Object.values(SANDBOX_NAMES).filter((name) => name.startsWith('secrets.')).map((name) => name.slice('secrets.'.length)),
  CANARY_SECRET,
].map((name) => name.toUpperCase()));

/**
 * Why a workflow, as GitHub ran it, could write to the repository with a
 * credential other than an App token its own steps minted: a job whose
 * token (`github.token`) may write contents or keeps the repository's
 * default permissions, a secret outside `RUN_SECRETS` (or the whole
 * `secrets` context) handed to a job, or a job that calls a reusable
 * workflow, whose own jobs and secrets this file does not show. Empty when
 * there is no such way. Comments are not read: only the values GitHub
 * evaluates, whose context and secret names GitHub reads in any case.
 */
export function workflowWriteCredentials(text: string): string[] {
  const doc = parseDocument(text);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return ['is not a workflow GitHub can read'];
  const root = doc.contents;
  const problems: string[] = [];
  const top = root.get('permissions', true);
  const jobs = root.get('jobs');
  if (!isMap(jobs) || jobs.items.length === 0) return ['has no jobs'];
  for (const pair of jobs.items) {
    const name = String(isScalar(pair.key) ? pair.key.value : pair.key);
    const job = pair.value;
    if (!isMap(job)) continue;
    if (job.has('uses')) problems.push(`calls a reusable workflow in job "${name}"`);
    const own = job.get('permissions', true);
    const permissions = own ?? top;
    if (permissions === undefined) problems.push(`gives job "${name}" the repository's default token permissions`);
    else if (canWriteContents(permissions)) problems.push(`lets job "${name}" write contents with the job's own token`);
  }
  // Only expressions reach the secrets: a script's own word "secrets" is text.
  for (const expression of scalars(root).flatMap((value) => [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((match) => match[1]!))) {
    for (const match of expression.matchAll(/\bsecrets\b(\s*\.\s*([A-Za-z_][A-Za-z0-9_]*))?/gi)) {
      const secret = match[2];
      if (secret === undefined) problems.push('hands a job the whole secrets context');
      else if (!RUN_SECRETS.has(secret.toUpperCase())) problems.push(`hands a job the secret ${secret}`);
    }
  }
  return [...new Set(problems)];
}

/** Whether a `permissions` value lets the job's token write contents. */
function canWriteContents(permissions: unknown): boolean {
  if (isScalar(permissions)) return permissions.value === 'write-all';
  if (isMap(permissions)) {
    const contents = permissions.get('contents');
    return contents === 'write';
  }
  // Anything else (a list, an alias) is not a shape GitHub reads as read-only.
  return true;
}

/** Every string value in a YAML tree: keys and values, never comments. */
function scalars(node: unknown): string[] {
  if (isScalar(node)) return typeof node.value === 'string' ? [node.value] : [];
  if (isMap(node)) return node.items.flatMap((pair) => [...scalars(pair.key), ...scalars(pair.value)]);
  if (isSeq(node)) return node.items.flatMap((item) => scalars(item as Node));
  return [];
}

/**
 * The client ids the run's App token steps minted their tokens for, as the
 * runner logged each step's evaluated inputs before running it:
 *
 *     ##[group]Run actions/create-github-app-token@<sha>
 *     with:
 *       client-id: <client id>
 *       private-key: ***
 *     ##[endgroup]
 *
 * One entry per such step in the logs (a step's own log file and the job's
 * whole log both carry it). A step logged without a `client-id` gives an
 * empty string, which matches no App.
 */
export function appTokenClientIds(logs: Iterable<string>): string[] {
  const ids: string[] = [];
  for (const log of logs) {
    let inStep = false;
    let id: string | undefined;
    for (const raw of log.split(/\r?\n/)) {
      const line = raw.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, '');
      if (line.startsWith('##[group]Run ')) {
        inStep = line.slice('##[group]Run '.length).startsWith(APP_TOKEN_ACTION);
        id = undefined;
      } else if (inStep && line.startsWith('##[endgroup]')) {
        ids.push(id ?? '');
        inStep = false;
      } else if (inStep) {
        const input = /^\s+client-id: (.*)$/.exec(line);
        if (input !== null) id = input[1]!.trim();
      }
    }
  }
  return ids;
}

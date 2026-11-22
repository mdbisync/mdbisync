// `git.init-files`: a person prepares the repository with `mdbisync init`
// instead of writing its files by hand (L1-23). The setup's repository is
// turned back into one that was never prepared: the annotation READMEs lose
// their `linear-team` and `linear-project` keys and the files `init` writes
// are removed. Then `init` runs, the person annotates each folder by hand
// (its README gets back the annotation the setup gave it), and commits the
// result.
//
// The step checks what `init` promises: every file it writes parses, the
// workflows and the format hook pin the release it was given, it leaves the
// READMEs as they are, and a second run changes nothing. A broken promise is
// a product failure.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import templates from '../../../src/init/workflows.json' with { type: 'json' };
import { runInit } from '../../../src/init/command.ts';
import { MINIMUM_RELEASE, RELEASE_PIN } from '../../../src/init/releases.ts';
import { findFrontMatter } from '../../../src/mapping/front-matter.ts';
import { PRE_COMMIT_CONFIG } from '../../../src/setup/hooks.ts';
import type { RunContext } from './context.ts';
import { readAnnotation } from './corpus.ts';
import { ProductError } from './results.ts';
import { commitAsPerson, pull } from './step-helpers.ts';

/** The files `init` writes. */
export const INIT_FILES: readonly string[] = [PRE_COMMIT_CONFIG, ...Object.keys(templates).map((name) => `.github/workflows/${name}`)];

const ANNOTATION_KEY = /^linear-(?:team|project):/;

/** A README without its `linear-team` and `linear-project` keys; front matter left empty is removed. */
export function withoutAnnotation(text: string): string {
  const found = findFrontMatter(text);
  if (found === null) return text;
  const opening = /^﻿?---[^\S\r\n]*\r?\n/.exec(text)?.[0];
  if (opening === undefined) return text;
  const eol = opening.endsWith('\r\n') ? '\r\n' : '\n';
  const kept = found.yaml.split(/\r?\n/).filter((entry) => !ANNOTATION_KEY.test(entry));
  const rest = text.slice(opening.length + found.yaml.length);
  if (kept.every((entry) => entry.trim() === '')) {
    // The closing fence and its line ending go with the emptied front matter.
    return rest.replace(/^\r?\n?---[^\S\r\n]*(?:\r?\n|$)/, '');
  }
  return opening + kept.join(eol) + rest;
}

/** The `init` arguments for this release. */
export function initArguments(release: { sha: string; version?: string }): string[] {
  return ['--release-sha', release.sha, ...(release.version === undefined ? [] : ['--release-version', release.version]), '--no-security-hooks'];
}

/**
 * The release `init` pins: the release under test when the run names one
 * (`MDBISYNC_TEST_ACTION_SHA`), else the release the templates pin. The
 * version comment is given only when the harness knows it.
 */
export function initRelease(actionSha: string | undefined): { sha: string; version?: string } {
  if (actionSha === undefined || actionSha === MINIMUM_RELEASE.sha) return { sha: MINIMUM_RELEASE.sha, version: MINIMUM_RELEASE.version };
  return { sha: actionSha };
}

export async function initFiles(ctx: RunContext, actionSha: string | undefined): Promise<void> {
  const git = await ctx.person();
  await pull(git, ctx);
  const tracked = (await git.text(['ls-files', '-z'])).split('\0').filter(Boolean);
  const readmes = new Map<string, string>();
  for (const path of tracked.filter((candidate) => /(^|\/)README\.md$/.test(candidate)).sort()) {
    const text = readFileSync(join(git.dir, path), 'utf8');
    if (readAnnotation(text) !== null) readmes.set(path, text);
  }
  if (readmes.size === 0) throw new Error('git.init-files found no annotated folder in the repository');

  // The repository as a person has it before preparing it.
  const unprepared = new Map<string, string | null>();
  for (const [path, text] of readmes) unprepared.set(path, withoutAnnotation(text));
  for (const path of INIT_FILES) if (existsSync(join(git.dir, path))) unprepared.set(path, null);
  for (const [path, text] of unprepared) {
    if (text === null) unlinkSync(join(git.dir, path));
    else writeFileSync(join(git.dir, path), text);
  }

  const release = initRelease(actionSha);
  const args = initArguments(release);
  const outputs = [...INIT_FILES, ...readmes.keys()];
  let written: Map<string, string>;
  try {
    written = await runCheckedInit(git.dir, args, release, unprepared);
  } finally {
    // The clone goes back to its commit whether init kept its promises or not, so a failure leaves no half-prepared
    // clone behind for the checks, and the commit below pulls cleanly and then writes what init wrote.
    await git.run(['reset', '--quiet', '--hard', 'HEAD']);
    await git.run(['clean', '--quiet', '-f', '--', ...outputs]);
  }
  // The person annotates each folder by hand: its README gets back the team and project the setup gave it.
  for (const [path, text] of readmes) written.set(path, text);
  // The hooks this commit adds are not installed yet; the person commits the prepared files as they are.
  await commitAsPerson(ctx, new Map(written), 'Prepare the repository for the sync', true);
  ctx.observations.set('init.arguments', args);
  ctx.observations.set('init.files', outputs);
  writeFileSync(join(ctx.runDir, 'init-files.json'), `${JSON.stringify({ release, arguments: args, annotated: [...readmes.keys()], removedBeforeInit: [...unprepared].filter(([, text]) => text === null).map(([path]) => path), written: Object.fromEntries(written), idempotent: true }, null, 2)}\n`);
}

/** A file `init` must have written; a missing one is init's failure. */
function writtenFile(dir: string, path: string): string {
  if (!existsSync(join(dir, path))) throw new ProductError(`init did not write ${path}`);
  return readFileSync(join(dir, path), 'utf8');
}

/** The text of `path` in `dir`, or null when it is missing. */
function current(dir: string, path: string): string | null {
  return existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : null;
}

/**
 * Runs `init` twice in `dir` and checks what it promises; returns the files the first run wrote.
 * `unprepared` holds the repository's files before init: the READMEs without annotations, and null for init's own files.
 */
async function runCheckedInit(dir: string, args: readonly string[], release: { sha: string }, unprepared: ReadonlyMap<string, string | null>): Promise<Map<string, string>> {
  const first = await runInit(args, { cwd: dir });
  if (first.exitCode !== 0) throw new ProductError(`init failed: ${first.stderr.trim()}`);
  const written = new Map(INIT_FILES.map((path) => [path, writtenFile(dir, path)]));
  for (const [path, text] of written) {
    if (!/\.ya?ml$/.test(path)) continue;
    try { parse(text); } catch (error) { throw new ProductError(`init wrote ${path} that does not parse as YAML: ${(error as Error).message}`); }
  }
  if (!(written.get(PRE_COMMIT_CONFIG) ?? '').includes(`rev: ${release.sha}`)) throw new ProductError(`init did not pin the format hook to ${release.sha}`);
  for (const [name, template] of Object.entries(templates)) {
    const path = `.github/workflows/${name}`;
    // Only the workflows that run the sync's action pin a release; the pre-commit workflow runs the hooks.
    if (RELEASE_PIN.test(template) && !(written.get(path) ?? '').includes(`mdbisync/mdbisync@${release.sha}`)) throw new ProductError(`init did not pin ${path} to ${release.sha}`);
  }
  // Folder annotations are the person's: init leaves every README as it found it.
  const touched = [...unprepared].filter(([path, before]) => before !== null && current(dir, path) !== before).map(([path]) => path);
  if (touched.length > 0) throw new ProductError(`init changed ${touched.join(', ')}`);
  const second = await runInit(args, { cwd: dir });
  if (second.exitCode !== 0) throw new ProductError(`init failed when run again: ${second.stderr.trim()}`);
  const changedAgain = INIT_FILES.filter((path) => writtenFile(dir, path) !== written.get(path));
  if (changedAgain.length > 0) throw new ProductError(`init run again changed ${changedAgain.join(', ')}`);
  return written;
}

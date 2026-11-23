// After a final release is tagged, moves the workflow templates to it: the
// `mdbisync/mdbisync@<sha> # <version>` pins in `examples/`, the copy of
// the templates `init` embeds, the list of releases `init` refuses as
// older, and the configuration page that names the oldest release `init`
// writes. A pre-release never moves them, so nobody copies a release
// candidate from the examples. A release commit cannot name its own SHA, so
// the release cannot carry these pins; this step commits them on a branch
// cut from `main` and pushes that branch, and a pull request takes it to
// `main` through the usual checks. It needs only Node and Git, like the tag
// step.
import { execFileSync } from 'node:child_process';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateSha, validateVersion } from './package.ts';

export interface Release { readonly sha: string; readonly version: string }

/** A template's pin of the action, as `src/init/releases.ts` reads it. */
const PIN = /mdbisync\/mdbisync@([a-f0-9]{40}) # (v\S+)/g;

export const EXAMPLES = 'examples';
export const INIT_TEMPLATES = 'src/init/workflows.json';
export const OLDER_RELEASES = 'src/init/older-releases.json';
export const CONFIGURATION_PAGE = 'docs/configuration.md';

/** The branch a release's pins are pushed to. */
export const pinBranch = (version: string): string => `release-pins-${version}`;

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The places of the configuration page that name the oldest release `init`
 * writes, each found exactly once; `test/docs/configuration.test.ts` reads
 * the same two.
 */
const PAGE_MENTIONS = [
  (version: string) => new RegExp(`(\`)${escape(version)}(\` or a later release)`, 'g'),
  (version: string) => new RegExp(`(their examples pin,\\s+\`)${escape(version)}(\`)`, 'g'),
];

/** The one release every pin in `texts` names; refuses none, or pins that differ. */
export function pinnedRelease(texts: Readonly<Record<string, string>>): Release {
  const found = new Map<string, Release>();
  for (const [file, text] of Object.entries(texts)) {
    for (const [, sha, version] of text.matchAll(PIN)) found.set(`${sha} ${version}`, { sha: sha!, version: version! });
    if (found.size > 1) throw new Error(`${file}: the templates pin more than one release`);
  }
  const [release] = found.values();
  if (release === undefined) throw new Error('No template pins a release');
  return release;
}

/** What the step does: the files it changes, by path, or why the templates keep their pin. */
export type Pins = { readonly files: Record<string, string>; readonly kept?: undefined } | { readonly files?: undefined; readonly kept: string };

const isPreRelease = (version: string): boolean => version.includes('-');

/**
 * The files that move the templates from their pinned release to `release`,
 * by path; only those that change. `files` holds the current text of every
 * example template, the embedded templates, the older releases and the
 * configuration page. `tags` lists every release tag, oldest first, with the
 * commit it names; `release` must be among them. The templates keep their
 * pin when `release` is a pre-release, and when they already pin `release`
 * or a later release.
 */
export function pinFiles(files: Readonly<Record<string, string>>, release: Release, tags: readonly Release[]): Pins {
  validateSha(release.sha);
  validateVersion(release.version);
  const examples = Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith(`${EXAMPLES}/`)));
  const previous = pinnedRelease(examples);
  const position = (version: string) => tags.findIndex((tag) => tag.version === version);
  const index = position(release.version);
  if (index < 0 || tags[index]!.sha !== release.sha) throw new Error(`The tag ${release.version} does not name ${release.sha}`);
  if (isPreRelease(release.version)) return { kept: `${release.version} is a pre-release: the workflow templates keep their pin, and only a final release moves them.` };
  if (previous.version === release.version && previous.sha === release.sha) return { kept: `The workflow templates on main already pin ${release.version}.` };
  if (position(previous.version) >= index) return { kept: `The workflow templates on main pin ${previous.version}, which is not older than ${release.version}; they keep it.` };

  const changed: Record<string, string> = {};
  const pin = `mdbisync/mdbisync@${release.sha} # ${release.version}`;
  for (const [path, text] of Object.entries(examples)) {
    const pinned = text.replace(PIN, pin);
    if (pinned !== text) changed[path] = pinned;
  }

  // `init` embeds the examples byte for byte (`src/init/init.test.ts`).
  const embedded = JSON.parse(required(files, INIT_TEMPLATES)) as Record<string, string>;
  const templates = Object.fromEntries(Object.keys(embedded).map((name) => {
    const path = `${EXAMPLES}/${name}`;
    if (!(path in examples)) throw new Error(`${INIT_TEMPLATES} embeds ${name}, which ${EXAMPLES}/ lacks`);
    return [name, changed[path] ?? examples[path]!];
  }));
  changed[INIT_TEMPLATES] = `${JSON.stringify(templates, null, 2)}\n`;

  changed[OLDER_RELEASES] = `${JSON.stringify(Object.fromEntries(tags.slice(0, index).map((tag) => [tag.sha, tag.version])), null, 2)}\n`;

  let page = required(files, CONFIGURATION_PAGE);
  for (const mention of PAGE_MENTIONS) {
    const pattern = mention(previous.version);
    const count = [...page.matchAll(pattern)].length;
    if (count !== 1) throw new Error(`${CONFIGURATION_PAGE} names the oldest release ${count} times where one is expected (${pattern.source})`);
    page = page.replace(pattern, `$1${release.version}$2`);
  }
  changed[CONFIGURATION_PAGE] = page;

  for (const [path, text] of Object.entries(changed)) if (text === files[path]) delete changed[path];
  return { files: changed };
}

function required(files: Readonly<Record<string, string>>, path: string): string {
  const text = files[path];
  if (text === undefined) throw new Error(`Missing ${path}`);
  return text;
}

/**
 * In `repository`, a clean checkout of `main` with every release tag,
 * commits the pins of the final release `release` on a new branch and pushes
 * it to `origin`; a pre-release pushes nothing.
 * The push never forces, and a branch left by an earlier run refuses it.
 * Returns the branch, or why the templates keep their pin.
 */
export async function pinRelease(repository: string, release: Release): Promise<{ branch: string } | { kept: string }> {
  validateVersion(release.version);
  validateSha(release.sha);
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  const tags = git('-c', 'versionsort.suffix=-', 'tag', '--list', 'v*', '--sort=version:refname').split('\n').filter(Boolean)
    .map((version) => ({ version, sha: git('rev-parse', '--verify', '--quiet', `refs/tags/${version}^{commit}`) }));
  if (git('status', '--porcelain')) throw new Error('The checkout has local changes');

  const files: Record<string, string> = {};
  for (const name of (await readdir(join(repository, EXAMPLES))).filter((file) => file.endsWith('.yml')).sort()) {
    files[`${EXAMPLES}/${name}`] = await readFile(join(repository, EXAMPLES, name), 'utf8');
  }
  for (const path of [INIT_TEMPLATES, OLDER_RELEASES, CONFIGURATION_PAGE]) files[path] = await readFile(join(repository, path), 'utf8');
  const pins = pinFiles(files, release, tags);
  if (pins.kept !== undefined) return { kept: pins.kept };
  const changed = pins.files;

  const branch = pinBranch(release.version);
  // A plain push would also fast-forward a branch an earlier run left; only a new branch is pushed.
  // Release runs share one concurrency group, so no other run creates it in between.
  // ls-remote patterns also match ref-name tails; compare the exact ref.
  const ref = `refs/heads/${branch}`;
  if (git('ls-remote', '--refs', 'origin', ref).split('\n').some((line) => line.split(/\s+/)[1] === ref)) throw new Error(`The branch ${branch} already exists on origin`);
  git('switch', '--quiet', '--create', branch);
  for (const [path, text] of Object.entries(changed)) await writeFile(join(repository, path), text);
  git('add', '--', ...Object.keys(changed));
  git('commit', '--quiet', '-m', `Pin the workflow templates to ${release.version}\n\nRelease commit: ${release.sha}`);
  git('push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
  return { branch };
}

if (import.meta.main) {
  const [version, sha, repository] = process.argv.slice(2);
  if (!version || !sha || !repository) throw new Error('Usage: pins.ts VERSION RELEASE_SHA REPOSITORY');
  const result = await pinRelease(repository, { version, sha });
  const server = process.env.GITHUB_SERVER_URL;
  const project = process.env.GITHUB_REPOSITORY;
  const summary = 'kept' in result
    ? `${result.kept}\n`
    : `The workflow templates pinned to ${version} are on the branch \`${result.branch}\`.`
      + (server && project ? ` Compare it with main: ${server}/${project}/compare/main...${result.branch}?expand=1\n` : '\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  // The next steps open the pull request from this branch.
  if ('branch' in result && process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `branch=${result.branch}\n`);
}

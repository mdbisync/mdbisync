import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createReleaseCommit, validateVersion, verifyReleaseDirectory } from './package.ts';

// This step needs only Node and Git; dependency installation belongs to the build job.
export async function tagRelease(sourceSha: string, version: string, directory: string, repository = process.cwd()): Promise<string> {
  validateVersion(version);
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  const head = git('rev-parse', 'HEAD');
  if (head !== sourceSha) throw new Error('Source SHA must match the checked-out source');
  git('merge-base', '--is-ancestor', sourceSha, 'origin/main');
  const existing = git('ls-remote', '--tags', 'origin', `refs/tags/${version}`);
  if (existing !== '') throw new Error('Release tag already exists; choose a new version');
  await verifyReleaseDirectory(resolve(directory), sourceSha, version);
  const releaseSha = await createReleaseCommit({ repository, directory: resolve(directory), sourceSha, version });
  git('tag', '-a', version, releaseSha, '-m', `Release ${version}\n\nSource: ${sourceSha}`);
  git('push', 'origin', `refs/tags/${version}:refs/tags/${version}`);
  return releaseSha;
}

if (import.meta.main) {
  const [sourceSha, version, directory] = process.argv.slice(2);
  if (!sourceSha || !version || !directory) throw new Error('Usage: tag.ts SOURCE_SHA VERSION RELEASE_DIRECTORY');
  const releaseSha = await tagRelease(sourceSha, version, directory);
  const summary = `Release tag: ${version}\n\nSource: \`${sourceSha}\`\n\nRelease SHA: \`${releaseSha}\`\n\nPin the action and hook to the release SHA. No GitHub Release was published.\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}

import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createReleaseCommit, validateSha, validateVersion, verifyReleaseDirectory } from './package.ts';

// This step needs only Node and Git; dependency installation belongs to the build job.
export async function tagRelease(sourceSha: string, version: string, directory: string, repository = process.cwd()): Promise<string> {
  validateVersion(version);
  validateSha(sourceSha);
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();
  const releaseRef = 'refs/heads/releases';
  // ls-remote patterns also match ref-name tails. Read only the exact ref.
  const remoteRef = (ref: string) => git('ls-remote', '--refs', 'origin', ref).split('\n')
    .map(line => line.split(/\s+/)).find(([, name]) => name === ref)?.[0];
  const remoteHead = () => remoteRef(releaseRef);
  const previousRelease = remoteHead();
  if (previousRelease !== undefined) {
    validateSha(previousRelease);
    git('fetch', '--no-tags', 'origin', previousRelease);
  }
  git('merge-base', '--is-ancestor', sourceSha, 'origin/main');
  if (remoteRef(`refs/tags/${version}`) !== undefined) throw new Error('Release tag already exists; choose a new version');
  await verifyReleaseDirectory(resolve(directory), sourceSha, version);
  const releaseSha = await createReleaseCommit({ repository, directory: resolve(directory), sourceSha, version, previousRelease });
  if (remoteHead() !== previousRelease) throw new Error('The releases branch moved; start a new release run');
  git('tag', '-a', version, releaseSha, '-m', `Release ${version}\n\nSource: ${sourceSha}`);
  // An ordinary fast-forward push rejects a concurrent advance. Atomicity keeps
  // the tag unpublished if either ref is rejected; neither ref is ever forced.
  git('push', '--atomic', 'origin', `${releaseSha}:${releaseRef}`, `refs/tags/${version}:refs/tags/${version}`);
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

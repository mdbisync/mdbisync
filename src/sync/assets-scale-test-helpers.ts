// A capture whose document refers many times to one cached upload, in a tree
// holding many copies of the upload's bytes. Run by a scale test in a child
// process.

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from '../state/git.ts';
import { resolveStateConfig } from '../state/index.ts';
import { createAssetCapture } from './assets.ts';

/**
 * Captures `zz/doc.md`, `references` images of one cached upload, against a
 * tree of `copies` copies of its bytes in `a/` and its capture in
 * `zz/assets/`, with `cached` uploads in the cache. Returns the time of the
 * capture and whether every reference was linked to the capture.
 */
export async function captureManyCopies(copies: number, cached: number, references: number): Promise<{ ms: number; linked: boolean }> {
  const png = await readFile(new URL('../../test/fixtures/assets/pixel.png', import.meta.url));
  const hash = createHash('sha256').update(png).digest('hex');
  const url = 'https://uploads.linear.app/w/0';
  const dir = await mkdtemp(join(tmpdir(), 'assets-scale-'));
  try {
    const git = new Git(dir, { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' });
    await git.run(['init', '--quiet', '--bare']);
    const blob = (await git.run(['hash-object', '-w', '--stdin'], { input: png })).stdout.toString().trim();
    const tree = async (entries: string[]) => (await git.run(['mktree'], { input: `${entries.join('\n')}\n` })).stdout.toString().trim();
    const copiesTree = await tree(Array.from({ length: copies }, (_, index) => `100644 blob ${blob}\tcopy-${index}.png`));
    const documentTree = await tree([`040000 tree ${await tree([`100644 blob ${blob}\t${hash}.png`])}\tassets`]);
    // The copies sort before the document's folder: the search for its capture passes all of them.
    const root = await tree([`040000 tree ${copiesTree}\ta`, `040000 tree ${documentTree}\tzz`]);
    const base = (await git.run(['commit-tree', root, '-m', 'Copies'])).stdout.toString().trim();
    const uploads = new Map([[hash, url]]);
    for (let index = 1; index < cached; index++) uploads.set(createHash('sha256').update(String(index)).digest('hex'), `https://uploads.linear.app/w/${index}`);
    const capture = createAssetCapture(git, resolveStateConfig({}), base, async () => {
      throw new Error('no download expected');
    });
    try {
      const start = performance.now();
      const captured = await capture('zz/doc.md', `![a](${url})\n\n`.repeat(references), uploads);
      return { ms: performance.now() - start, linked: captured.body === `![a](assets/${hash}.png)\n\n`.repeat(references) };
    } finally {
      capture.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

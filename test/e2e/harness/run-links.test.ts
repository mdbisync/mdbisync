// The run tree moves team-zone files below the run id and keeps project
// folders in place. A relative link between the two must still reach the
// same corpus file in the run, or the initial sync leaves the linking file
// out (`image-file-missing`) although the corpus means it to sync.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCorpus } from '../../corpus/generate.ts';
import { linkDestinations, linkedFile } from './checks.ts';
import { buildRunTree } from './corpus.ts';
import { runNames } from './isolation.ts';
import { relinkRunTree } from './run-links.ts';

const names = runNames('abc123');
const README = (front: string): string => `---\n${front}\n---\n`;

/** Where each link of a run-tree file lands in the run, mapped back to its corpus path. */
function resolvedSources(tree: ReturnType<typeof buildRunTree>, target: string, text: string): Array<string | undefined> {
  return linkDestinations(text).map((destination) => {
    const file = linkedFile(target, destination.url);
    return file === undefined ? undefined : tree.paths.get(file.path);
  });
}

describe('run tree links', () => {
  const zoneFile = 'eng/on-call (rotation)/reference/who-to-ask.md';
  const projectFile = 'eng/platform/notes.md';
  const corpus = new Map([
    ['eng/README.md', README('linear-team: ENG')],
    ['eng/platform/README.md', README('linear-project: PROJECT_ENG_1')],
    [projectFile, '# Notes\n\nBack to [who to ask](../on-call%20(rotation)/reference/who-to-ask.md#owners) and [its neighbour](/eng/on-call%20(rotation)/reference/neighbour.md).\n'],
    [zoneFile, [
      '# Who to ask',
      '',
      '![status](../../platform/assets/status-icon.png)',
      '',
      'See [the notes](<../../platform/notes.md#setup>), [a neighbour](./neighbour.md) and [the site](https://example.com/x).',
      '',
      'Also [from the root](/eng/platform/notes.md), [an entity](../../platform/notes.md&#35;setup), [a draft](../../platform/draft%29.md) and [über](../../platform/%C3%BCber.md#start).',
      '',
      '[ref]: ../../platform/assets/status-icon.png',
      '',
      '`../../platform/assets/status-icon.png` in code stays.',
      '',
    ].join('\n')],
    ['eng/on-call (rotation)/reference/neighbour.md', '# Neighbour\n'],
    ['eng/platform/assets/status-icon.png', ''],
    ['eng/platform/draft).md', '# Draft\n'],
    ['eng/platform/über.md', '# Über\n'],
  ]);
  const readmes = new Map([...corpus].filter(([path]) => path.endsWith('README.md')));
  const tree = relinkRunTree(buildRunTree({ slice: 'mini', paths: [...corpus.keys()] }, readmes, names), corpus);
  const zoneTarget = 'eng/abc123/on-call (rotation)/reference/who-to-ask.md';

  it('points a moved zone file\'s links into an unmoved project folder at the same corpus files', () => {
    assert.equal(tree.paths.get(zoneTarget), zoneFile);
    assert.equal(tree.paths.get('eng/platform/assets/status-icon.png'), 'eng/platform/assets/status-icon.png');
    const text = tree.rewritten.get(zoneTarget);
    assert.ok(text !== undefined, 'the zone file is rewritten');
    assert.deepEqual(resolvedSources(tree, zoneTarget, text), [
      'eng/platform/assets/status-icon.png',
      'eng/platform/notes.md',
      'eng/on-call (rotation)/reference/neighbour.md',
      undefined,
      'eng/platform/notes.md',
      'eng/platform/notes.md',
      'eng/platform/draft).md',
      'eng/platform/über.md',
      'eng/platform/assets/status-icon.png',
    ]);
    // Only the paths change: angle brackets and fragments stay, links within the zone, URLs and code stay as written.
    assert.match(text, /!\[status\]\(\.\.\/\.\.\/\.\.\/platform\/assets\/status-icon\.png\)/);
    assert.match(text, /\[the notes\]\(<\.\.\/\.\.\/\.\.\/platform\/notes\.md#setup>\)/);
    assert.match(text, /\[a neighbour\]\(\.\/neighbour\.md\)/);
    assert.match(text, /\(https:\/\/example\.com\/x\)/);
    // A root-relative link already reaches its file; an entity's `#` is a fragment; parentheses and non-ASCII are encoded.
    assert.match(text, /\[from the root\]\(\/eng\/platform\/notes\.md\)/);
    assert.match(text, /\[an entity\]\(\.\.\/\.\.\/\.\.\/platform\/notes\.md#setup\)/);
    assert.match(text, /\[a draft\]\(\.\.\/\.\.\/\.\.\/platform\/draft%29\.md\)/);
    assert.match(text, /\[über\]\(\.\.\/\.\.\/\.\.\/platform\/%C3%BCber\.md#start\)/);
    assert.match(text, /^\[ref\]: \.\.\/\.\.\/\.\.\/platform\/assets\/status-icon\.png$/m);
    assert.match(text, /^`\.\.\/\.\.\/platform\/assets\/status-icon\.png` in code stays\.$/m);
  });

  it('points an unmoved project file\'s link into a moved zone folder at the run\'s path', () => {
    const text = tree.rewritten.get(projectFile);
    assert.ok(text !== undefined);
    assert.deepEqual(resolvedSources(tree, projectFile, text), [zoneFile, 'eng/on-call (rotation)/reference/neighbour.md']);
    assert.match(text, /\(\/eng\/abc123\/on-call%20%28rotation%29\/reference\/neighbour\.md\)/);
    assert.match(text, /\(\.\.\/abc123\/on-call%20%28rotation%29\/reference\/who-to-ask\.md#owners\)/);
  });

  it('leaves files whose links already reach their targets unrewritten, and keeps the annotation READMEs', () => {
    assert.equal(tree.rewritten.has('eng/abc123/on-call (rotation)/reference/neighbour.md'), false);
    assert.match(tree.rewritten.get('eng/platform/README.md') as string, /linear-project: Field notes abc123/);
    assert.deepEqual([...tree.rewritten.keys()].sort(), [projectFile, 'eng/platform/README.md', zoneTarget].sort());
  });

  it('gives every link of the generated full slice its corpus target in the run', () => {
    const generated = buildCorpus('0'.repeat(40));
    const text = new Map(generated.files.map((file) => [file.path, file.content.toString('utf8')]));
    const paths = generated.slices.full;
    const sliceReadmes = new Map(paths.filter((path) => /(^|\/)README\.md$/.test(path)).map((path) => [path, text.get(path) ?? '']));
    const markdown = new Map(paths.filter((path) => path.endsWith('.md')).map((path) => [path, text.get(path) ?? '']));
    const full = relinkRunTree(buildRunTree({ slice: 'full', paths }, sliceReadmes, names), markdown);
    const inSlice = new Set(paths);
    const linking = new Set(generated.manifest.files.filter((file) => (file.links ?? []).length > 0).map((file) => file.path));
    let checked = 0;
    for (const [target, source] of full.paths) {
      if (!source.endsWith('.md') || !linking.has(source)) continue;
      // Every link that reaches a slice file in the corpus reaches the same file in the run.
      const inCorpus = linkDestinations(text.get(source) as string).map((destination) => linkedFile(source, destination.url)?.path);
      const inRun = resolvedSources(full, target, full.rewritten.get(target) ?? (text.get(source) as string));
      assert.equal(inRun.length, inCorpus.length, source);
      inCorpus.forEach((path, index) => {
        if (path === undefined || !inSlice.has(path)) return;
        assert.equal(inRun[index], path, `${source} link ${index}`);
        checked += 1;
      });
    }
    assert.ok(checked > 0);
    // The six files of the live finding link the platform's status icon from a moved zone folder.
    for (const zone of ['frontend', 'on-call (rotation)']) {
      const moved = [...full.paths].filter(([target, source]) => source.startsWith(`eng/${zone}/reference/who-to-ask-about-`) && target.startsWith(`eng/abc123/${zone}/`));
      assert.equal(moved.length, 3, zone);
      for (const [target] of moved) assert.match(full.rewritten.get(target) as string, /\(\.\.\/\.\.\/\.\.\/platform\/assets\/status-icon\.png\)/, target);
    }
  });
});

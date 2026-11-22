import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nearestZone, resolveZones, type Zone } from './annotations.ts';
import { runScaleScript } from '../scale-test-helpers.ts';

describe('nearestZone', () => {
  const zone = (team: string): Zone => ({ team, teamFolder: team });
  const zones = new Map<string, Zone>([['', zone('root')], ['a/b', zone('ab')], ['a/b/c/d', zone('abcd')], ['x//y', zone('xy')]]);

  it('finds the nearest annotated folder at or above a folder', () => {
    assert.equal(nearestZone(zones, '')?.team, 'root');
    assert.equal(nearestZone(zones, 'a')?.team, 'root');
    assert.equal(nearestZone(zones, 'a/b')?.team, 'ab');
    assert.equal(nearestZone(zones, 'a/b/c')?.team, 'ab');
    assert.equal(nearestZone(zones, 'a/b/c/d/e')?.team, 'abcd');
    assert.equal(nearestZone(zones, 'a/bc')?.team, 'root');
    assert.equal(nearestZone(zones, 'x//y/z')?.team, 'xy');
    assert.equal(nearestZone(zones, 'x/y')?.team, 'root');
    assert.equal(nearestZone(zones, null), undefined);
    assert.equal(nearestZone(new Map([['a', zone('a')]]), 'b/a'), undefined);
  });

  it('reads a zones map again when it has grown', () => {
    const growing = new Map<string, Zone>([['a', zone('a')]]);
    assert.equal(nearestZone(growing, 'a/b/c')?.team, 'a');
    growing.set('a/b', zone('ab'));
    assert.equal(nearestZone(growing, 'a/b/c')?.team, 'ab');
  });

  it('reads a zones map again when a folder is given another zone', () => {
    const replaced = new Map<string, Zone>([['a', zone('a')]]);
    assert.equal(nearestZone(replaced, 'a/b')?.team, 'a');
    replaced.set('a', zone('other'));
    assert.equal(nearestZone(replaced, 'a/b')?.team, 'other');
  });

  it('resolves inheritance through the same lookup', () => {
    const { zones: resolved, problems } = resolveZones([
      { readme: 'README.md', folder: '', team: 'T' },
      { readme: 'p/README.md', folder: 'p', project: 'P' },
      { readme: 'p/q/README.md', folder: 'p/q', team: 'U' },
    ]);
    assert.deepEqual(resolved.get('p'), { team: 'T', teamFolder: '', project: 'P', projectFolder: 'p' });
    assert.deepEqual(problems.map((problem) => problem.kind), ['nested-team']);
  });

  // Each ancestor folder was looked up by its full path, which hashes every
  // prefix of the path: deep paths cost their depth times their length, for
  // every file of the tree. A child process with a timeout runs the lookups.
  it('looks up the files of a deep tree in time linear in its paths', () => {
    const result = runScaleScript<{ found: number }>({ annotations: new URL('./annotations.ts', import.meta.url) }, `
      const zones = new Map([['', { team: 'T', teamFolder: '' }]]);
      const deep = 'a/'.repeat(2000);
      let found = 0;
      for (let file = 0; file < 4000; file++) if (annotations.nearestZone(zones, deep + file) !== undefined) found++;
      console.log(JSON.stringify({ found }));
    `, 30_000);
    assert.equal(result.found, 4000);
  });
});

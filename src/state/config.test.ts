import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_STATE_CONFIG, StateConfigError, localRef, refNameProblem, resolveStateConfig, stateRef } from './index.ts';

describe('state config', () => {
  it('uses the default names when nothing is given', () => {
    assert.deepEqual(resolveStateConfig(), DEFAULT_STATE_CONFIG);
    assert.deepEqual(resolveStateConfig({ trackedBranch: '', syncBranch: '  ', refPrefix: '' }), DEFAULT_STATE_CONFIG);
    assert.equal(stateRef(resolveStateConfig(), 'linear'), 'refs/mdbisync/linear');
  });

  it('accepts names for an isolated test run', () => {
    const config = resolveStateConfig({ trackedBranch: 't/4f1a9c/main', syncBranch: 't/4f1a9c/sync', refPrefix: 'refs/mdbisync-t/4f1a9c/' });
    assert.equal(config.refPrefix, 'refs/mdbisync-t/4f1a9c');
    assert.equal(stateRef(config, 'ids'), 'refs/mdbisync-t/4f1a9c/ids');
    assert.equal(stateRef(config, 'uploads'), 'refs/mdbisync-t/4f1a9c/uploads');
  });

  it('maps branches to remote-tracking refs and keeps state refs as they are', () => {
    const config = resolveStateConfig();
    assert.equal(localRef(config, 'refs/heads/mdbisync/linear'), 'refs/remotes/origin/mdbisync/linear');
    assert.equal(localRef(config, 'refs/mdbisync/ids'), 'refs/mdbisync/ids');
  });

  const invalid: [string, Parameters<typeof resolveStateConfig>[0]][] = [
    ['a prefix outside refs/', { refPrefix: 'mdbisync' }],
    ['a prefix that is refs/ itself', { refPrefix: 'refs' }],
    ['a prefix under refs/heads', { refPrefix: 'refs/heads/state' }],
    ['a prefix under refs/tags', { refPrefix: 'refs/tags' }],
    ['a prefix with ".."', { refPrefix: 'refs/a..b' }],
    ['a branch with a space', { trackedBranch: 'my branch' }],
    ['a branch with ".lock"', { syncBranch: 'sync.lock' }],
    ['a branch starting with "-"', { trackedBranch: '-main' }],
    ['a branch with "@{"', { syncBranch: 'a@{1}' }],
    ['the same tracked and sync branch', { trackedBranch: 'main', syncBranch: 'main' }],
    ['a remote with a slash', { remote: 'a/b' }],
  ];
  for (const [name, input] of invalid) {
    it(`refuses ${name}`, () => {
      assert.throws(() => resolveStateConfig(input), StateConfigError);
    });
  }

  it('checks ref names like git does', () => {
    assert.equal(refNameProblem('refs/mdbisync/linear'), null);
    assert.notEqual(refNameProblem('refs/x/.hidden'), null);
    assert.notEqual(refNameProblem('refs/x//y'), null);
    assert.notEqual(refNameProblem('refs/x/y.'), null);
    assert.notEqual(refNameProblem('refs/x/a~b'), null);
    assert.notEqual(refNameProblem('refs/x/a\tb'), null);
  });
});

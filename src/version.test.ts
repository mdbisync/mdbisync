import assert from 'node:assert/strict';
import { it } from 'node:test';
import { olderVersion } from './version.ts';

it('orders releases as semantic versions do, so only a newer version reads again', () => {
  const ordered = ['0.9.9', '1.0.0', '1.0.1-rc.2', '1.0.1-rc.7', '1.0.1-rc.10', '1.0.1-rc.10.1', '1.0.1', '1.1.0', '2.0.0'];
  for (const [index, version] of ordered.entries()) {
    for (const [other, than] of ordered.entries()) assert.equal(olderVersion(version, than), index < other, `${version} before ${than}`);
  }
  assert.equal(olderVersion(undefined, '1.0.0'), true, 'no version is older than any');
  assert.equal(olderVersion('v1.0.0', '1.0.1'), true);
  // A version in another form is never taken as older: two runs of such builds do not read again and again.
  assert.equal(olderVersion('local-build', '1.0.0'), false);
  assert.equal(olderVersion('1.0.0', 'local-build'), false);
});

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { commitTree } from './objects.ts';
import { signObservation, signedObservation, trustedObservation } from './observation.ts';
import { PushedKey } from './pushed.ts';
import { IDENTITY, type Fixture, createFixture } from './test-helpers.ts';

describe('state: signed linear commits', () => {
  let fixture: Fixture;
  let main: string;
  const key = new PushedKey('secret', 'Owner/Repo');
  before(async () => {
    fixture = await createFixture();
    await fixture.seed({ 'docs/README.md': '# Docs\n' });
    main = await fixture.remote.text(['rev-parse', 'refs/heads/main']);
  });
  after(() => fixture.cleanup());

  const commit = (changes: Record<string, string>, options: { parents?: string[]; message?: string; sign?: PushedKey } = {}) => commitTree(fixture.remote, {
    parents: options.parents ?? [main], base: main, changes: new Map(Object.entries(changes)), message: options.message ?? 'Capture Linear changes\n\nPlain-link: a b\n', identity: IDENTITY,
    ...(options.sign === undefined ? {} : { sign: signObservation(options.sign) }),
  });
  /** A copy of `signed` with one part of the commit changed and its message kept, signature included. */
  const copy = async (signed: string, change: { tree?: string; parents?: string[]; message?: (text: string) => string }) => {
    const [tree, ...parents] = (await fixture.remote.text(['show', '-s', '--format=%T %P', signed])).split(' ');
    const text = (await fixture.remote.run(['cat-file', 'commit', signed])).stdout.toString('utf8');
    const message = text.slice(text.indexOf('\n\n') + 2);
    return fixture.remote.text(['commit-tree', change.tree ?? tree!, ...(change.parents ?? parents).flatMap((parent) => ['-p', parent]), '-F', '-'], { input: change.message?.(message) ?? message, env: { GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email } });
  };

  it('takes a commit it signed, with its message and trailers as written', async () => {
    const signed = await commit({ 'docs/a.md': '# A\n' }, { sign: key });
    assert.ok(await signedObservation(fixture.remote, signed, key));
    assert.ok(await signedObservation(fixture.remote, signed, new PushedKey('secret', 'owner/repo')));
    assert.match(await fixture.remote.text(['show', '-s', '--format=%B', signed]), /^Capture Linear changes\n\nPlain-link: a b\n\nSync-signature: [0-9a-f]{64}\n$/);
    assert.equal(await fixture.remote.text(['show', '-s', '--format=%s', signed]), 'Capture Linear changes');
  });

  it('refuses an unsigned commit, another tree, parents or message under the signature, and another secret or repository', async () => {
    const signed = await commit({ 'docs/a.md': '# A\n' }, { sign: key });
    const other = await commit({ 'docs/a.md': '# A\n', 'docs/x.md': '# Planted\n' });
    const otherTree = await fixture.remote.text(['rev-parse', `${other}^{tree}`]);
    for (const tip of [
      await commit({ 'docs/a.md': '# A\n' }),
      await copy(signed, { tree: otherTree }),
      await copy(signed, { parents: [other] }),
      await copy(signed, { parents: [main, other] }),
      await copy(signed, { message: (text) => text.replace('Plain-link: a b', 'Plain-link: a c') }),
      await copy(signed, { message: (text) => `${text}\n` }),
      await copy(signed, { message: (text) => text.toUpperCase() }),
    ]) assert.equal(await signedObservation(fixture.remote, tip, key), false, tip);
    assert.equal(await signedObservation(fixture.remote, signed, new PushedKey('another secret', 'owner/repo')), false);
    assert.equal(await signedObservation(fixture.remote, signed, new PushedKey('secret', 'owner/other')), false);
    // Another author or time changes nothing the sync reads: the copy is the same record.
    assert.ok(await signedObservation(fixture.remote, await copy(signed, {}), key));
  });

  it('refuses a signed message under an encoding header, which makes git read another subject', async () => {
    const signed = await commit({ 'docs/a.md': '# A\n' }, { sign: key });
    const raw = (await fixture.remote.run(['cat-file', 'commit', signed])).stdout.toString('utf8');
    const split = raw.indexOf('\n\n');
    const encoded = await fixture.remote.text(['hash-object', '-t', 'commit', '-w', '--stdin'], { input: `${raw.slice(0, split)}\nencoding UTF-7${raw.slice(split)}` });
    assert.equal(await signedObservation(fixture.remote, encoded, key), false);
  });

  it('signs the parents git stores when one is given twice', async () => {
    const signed = await commit({ 'docs/a.md': '# A\n' }, { parents: [main, main], sign: key });
    assert.equal(await fixture.remote.text(['show', '-s', '--format=%P', signed]), main);
    assert.ok(await signedObservation(fixture.remote, signed, key));
  });

  it('trusts an unsigned commit only when it holds a tree of the tracked branch\'s own history', async () => {
    const planted = await commit({ 'docs/x.md': '# Planted\n' });
    assert.ok(await trustedObservation(fixture.remote, main, main, key));
    assert.equal(await trustedObservation(fixture.remote, planted, main, key), false);
    // A commit merged in from another branch was never checked as the tracked branch, though the branch holds it.
    const merged = await commitTree(fixture.remote, { parents: [main, planted], base: main, changes: new Map([['docs/b.md', '# B\n']]), message: 'Merge', identity: IDENTITY });
    assert.equal(await trustedObservation(fixture.remote, planted, merged, key), false);
    // A record of the tracked branch's tree, as the sync's write step made it before it signed, whatever its parents.
    const record = await commitTree(fixture.remote, { parents: [planted, main], base: main, changes: new Map(), message: 'Sync: merge', identity: IDENTITY, skipIfUnchanged: false });
    assert.ok(await trustedObservation(fixture.remote, record, merged, key));
    assert.ok(await trustedObservation(fixture.remote, await commit({ 'docs/a.md': '# A\n' }, { sign: key }), main, key));
  });
});

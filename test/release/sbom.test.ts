import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { formatNotices, parseInventory } from '../../tools/licenses.ts';
import { createSbom, lockedSource, npmPurl } from '../../src/release/sbom.ts';

const sha = 'a'.repeat(40);
const integrity = `sha512-${Buffer.from('x'.repeat(64)).toString('base64')}`;
const lock = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'mdbisync' },
    'node_modules/@scope/one': { version: '1.0.0', resolved: 'https://registry.npmjs.org/@scope/one/-/one-1.0.0.tgz', integrity },
    'node_modules/two': { version: '2.0.0', resolved: 'https://registry.npmjs.org/two/-/two-2.0.0.tgz', integrity },
    'node_modules/@scope/one/node_modules/two': { version: '2.0.0', resolved: 'https://registry.npmjs.org/two/-/two-2.0.0.tgz', integrity },
    'node_modules/two/node_modules/one': { version: '1.0.0', resolved: 'https://registry.npmjs.org/one/-/one-1.0.0.tgz', integrity },
  },
};
const bundled = [
  { name: '@scope/one', version: '1.0.0', license: 'MIT' },
  { name: 'two', version: '2.0.0', license: 'ISC' },
];
// Written by the build's own notices formatter, so a change to its layout cannot silently break the SBOM.
const notices = formatNotices(bundled.map((entry) => ({ ...entry, path: `node_modules/${entry.name}`, noticeFiles: [{ file: 'LICENSE', text: 'license text' }] })));
const options = {
  repository: 'owner/name', name: 'mdbisync', license: 'MIT', version: 'v1.2.3', sourceSha: sha,
  bundled, lock, notices, created: new Date('2026-11-11T10:20:30.456Z'), documentId: 'run-1',
};

test('the SBOM describes the release and lists each bundled package with its source, checksum and purl', () => {
  const sbom = createSbom(options) as { packages: Record<string, unknown>[]; relationships: Record<string, string>[] } & Record<string, unknown>;
  assert.equal(sbom.spdxVersion, 'SPDX-2.3');
  assert.equal(sbom.dataLicense, 'CC0-1.0');
  assert.equal(sbom.documentNamespace, `https://github.com/owner/name/spdx/v1.2.3-${sha}-run-1`);
  assert.deepEqual(sbom.creationInfo, { created: '2026-11-11T10:20:30Z', creators: ['Tool: mdbisync-release-sbom'] });
  const [root, ...packages] = sbom.packages;
  assert.equal(root!.name, 'mdbisync');
  assert.equal(root!.versionInfo, '1.2.3');
  assert.equal(root!.downloadLocation, 'git+https://github.com/owner/name.git@v1.2.3');
  assert.match(String(root!.comment), new RegExp(sha));
  assert.deepEqual(packages.map((pkg) => [pkg.name, pkg.versionInfo, pkg.licenseDeclared, pkg.downloadLocation]), [
    ['@scope/one', '1.0.0', 'MIT', 'https://registry.npmjs.org/@scope/one/-/one-1.0.0.tgz'],
    ['two', '2.0.0', 'ISC', 'https://registry.npmjs.org/two/-/two-2.0.0.tgz'],
  ]);
  for (const pkg of sbom.packages) assert.equal(pkg.licenseConcluded, 'NOASSERTION');
  assert.deepEqual(packages[0]!.checksums, [{ algorithm: 'SHA512', checksumValue: Buffer.from('x'.repeat(64)).toString('hex') }]);
  assert.deepEqual(packages[0]!.externalRefs, [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: 'pkg:npm/%40scope/one@1.0.0' }]);
  for (const pkg of sbom.packages) assert.match(String(pkg.SPDXID), /^SPDXRef-[A-Za-z0-9.-]+$/);
  assert.deepEqual(sbom.relationships, [
    { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: root!.SPDXID },
    ...packages.map((pkg) => ({ spdxElementId: root!.SPDXID, relationshipType: 'CONTAINS', relatedSpdxElement: pkg.SPDXID })),
  ]);
});

test('the SBOM refuses a package the release notices do not list', () => {
  assert.throws(() => createSbom({ ...options, notices: notices.replace('two 2.0.0', 'two 2.0.1') }), /two@2\.0\.0 is in the inventory but not in the release notices/);
});

test('each SBOM document gets its own namespace, as SPDX requires', () => {
  const { documentId: _, ...rest } = options;
  const first = createSbom(rest).documentNamespace as string;
  const second = createSbom(rest).documentNamespace as string;
  assert.notEqual(first, second);
  assert.ok(first.startsWith(`https://github.com/owner/name/spdx/v1.2.3-${sha}-`));
});

test('the SBOM refuses an empty inventory', () => {
  assert.throws(() => createSbom({ ...options, bundled: [] }), /must list the bundled packages/);
});

test('the SBOM refuses a version without its v, a short SHA and a malformed repository', () => {
  assert.throws(() => createSbom({ ...options, version: '1.2.3' }), /semantic version/);
  assert.throws(() => createSbom({ ...options, sourceSha: 'abc' }), /full lowercase commit SHA/);
  assert.throws(() => createSbom({ ...options, repository: 'owner/name/../x' }), /owner\/name/);
});

test('a locked source must be unique, resolved and sha512', () => {
  assert.deepEqual(lockedSource(lock, bundled[1]!), { resolved: 'https://registry.npmjs.org/two/-/two-2.0.0.tgz', integrity });
  assert.throws(() => lockedSource(lock, { name: 'three', version: '1.0.0', license: 'MIT' }), /found 0/);
  const conflicting = { packages: { ...lock.packages, 'node_modules/x/node_modules/two': { version: '2.0.0', resolved: 'https://example.invalid/two.tgz', integrity } } };
  assert.throws(() => lockedSource(conflicting, bundled[1]!), /found 2/);
  const unresolved = { packages: { 'node_modules/two': { version: '2.0.0', integrity } } };
  assert.throws(() => lockedSource(unresolved, bundled[1]!), /resolved URL/);
  const sha1 = { packages: { 'node_modules/two': { version: '2.0.0', resolved: 'https://registry.npmjs.org/two/-/two-2.0.0.tgz', integrity: 'sha1-abc=' } } };
  assert.throws(() => createSbom({ ...options, bundled: [bundled[1]!], lock: sha1 }), /sha512/);
});

test('npm package URLs encode the scope', () => {
  assert.equal(npmPurl('@actions/core', '3.0.1'), 'pkg:npm/%40actions/core@3.0.1');
  assert.equal(npmPurl('yaml', '2.9.1'), 'pkg:npm/yaml@2.9.1');
});

test('every package of the real license inventory has one locked source', async () => {
  const inventory = parseInventory(await readFile(new URL('../../third-party-licenses.json', import.meta.url), 'utf8'));
  const realLock: unknown = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  for (const entry of inventory) assert.match(lockedSource(realLock, entry).integrity, /^sha512-/, `${entry.name}@${entry.version}`);
});

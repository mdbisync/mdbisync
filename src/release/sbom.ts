// Writes the SPDX 2.3 SBOM of a staged public release: the release package
// and every third-party package bundled into it.
//
// The bundled packages come from the license inventory, which the build has
// just checked against the bundles (it fails on any package bundled but not
// listed, or listed but not bundled). Each one must also have a section in
// the release tree's notices, so the SBOM describes the tree it ships with.
// Download locations and checksums come from the lockfile the build
// installed from. Like the other release scripts, this needs only Node.

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { NOTICES_FILE, validateSha, validateVersion, verifyReleaseDirectory } from './package.ts';

export interface BundledEntry { readonly name: string; readonly version: string; readonly license: string }
interface LockEntry { readonly version?: string; readonly resolved?: string; readonly integrity?: string }

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected a mapping in ${what}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`Missing ${what}`);
  return value;
}

export function parseBundled(value: unknown): BundledEntry[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('The license inventory must list the bundled packages');
  return value.map((item: unknown) => {
    const entry = record(item, 'the license inventory');
    return { name: text(entry.name, 'package name'), version: text(entry.version, 'package version'), license: text(entry.license, 'package license') };
  });
}

/** Finds the one download location and integrity hash the lockfile gives a package version. */
export function lockedSource(lock: unknown, entry: BundledEntry): { resolved: string; integrity: string } {
  const packages = record(record(lock, 'the lockfile').packages, 'the lockfile packages') as Record<string, LockEntry>;
  const found = new Map<string, { resolved: string; integrity: string }>();
  for (const [path, locked] of Object.entries(packages)) {
    if (!path.endsWith(`node_modules/${entry.name}`) || locked.version !== entry.version) continue;
    const source = { resolved: text(locked.resolved, `resolved URL of ${path}`), integrity: text(locked.integrity, `integrity of ${path}`) };
    found.set(`${source.resolved} ${source.integrity}`, source);
  }
  if (found.size !== 1) throw new Error(`Expected one locked source for ${entry.name}@${entry.version}, found ${found.size}`);
  return [...found.values()][0]!;
}

function sha512Hex(integrity: string): string {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match) throw new Error(`Expected a sha512 integrity hash, got ${integrity.split('-')[0]}`);
  return Buffer.from(match[1]!, 'base64').toString('hex');
}

// "@scope/name" -> "pkg:npm/%40scope/name@1.0.0", per the package URL spec for npm.
export function npmPurl(name: string, version: string): string {
  return `pkg:npm/${name.split('/').map(encodeURIComponent).join('/')}@${encodeURIComponent(version)}`;
}

function spdxId(name: string, version: string): string {
  return `SPDXRef-Package-npm-${`${name}-${version}`.replace(/[^A-Za-z0-9.-]/g, '-')}`;
}

export function createSbom(options: {
  repository: string; name: string; license: string; version: string; sourceSha: string;
  bundled: readonly BundledEntry[]; lock: unknown; notices: string; created: Date;
}): Record<string, unknown> {
  const { repository, name, license, version, sourceSha, bundled, lock, notices } = options;
  validateVersion(version);
  validateSha(sourceSha);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Expected a repository such as owner/name');
  const root = 'SPDXRef-Package-release';
  const packages = bundled.map((entry) => {
    // The notices section the build writes for each bundled package (tools/licenses.ts formatNotices).
    if (!notices.includes(`\n${entry.name} ${entry.version}\nLicense: ${entry.license}\n`)) {
      throw new Error(`${entry.name}@${entry.version} is in the inventory but not in the release notices`);
    }
    const { resolved, integrity } = lockedSource(lock, entry);
    return {
      SPDXID: spdxId(entry.name, entry.version),
      name: entry.name,
      versionInfo: entry.version,
      downloadLocation: resolved,
      filesAnalyzed: false,
      checksums: [{ algorithm: 'SHA512', checksumValue: sha512Hex(integrity) }],
      licenseConcluded: entry.license,
      licenseDeclared: entry.license,
      copyrightText: 'NOASSERTION',
      externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: npmPurl(entry.name, entry.version) }],
    };
  });
  if (new Set(packages.map((pkg) => pkg.SPDXID)).size !== packages.length) throw new Error('Duplicate bundled package in the inventory');
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${name}-${version}`,
    documentNamespace: `https://github.com/${repository}/spdx/${version}-${sourceSha}`,
    creationInfo: { created: options.created.toISOString().replace(/\.\d{3}Z$/, 'Z'), creators: [`Tool: ${name}-release-sbom`] },
    packages: [
      {
        SPDXID: root,
        name,
        versionInfo: version.slice(1),
        downloadLocation: `git+https://github.com/${repository}.git@${version}`,
        filesAnalyzed: false,
        licenseConcluded: license,
        licenseDeclared: license,
        copyrightText: 'NOASSERTION',
        externalRefs: [{ referenceCategory: 'PACKAGE-MANAGER', referenceType: 'purl', referenceLocator: `pkg:github/${repository}@${version}` }],
        comment: `Built from source commit ${sourceSha}. The third-party packages are bundled into its JavaScript files.`,
      },
      ...packages,
    ],
    relationships: [
      { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: root },
      ...packages.map((pkg) => ({ spdxElementId: root, relationshipType: 'CONTAINS', relatedSpdxElement: pkg.SPDXID })),
    ],
  };
}

/** Reads the source checkout the release was built from and the staged release, and writes the SBOM. */
export async function writeSbom(options: {
  repository: string; source: string; directory: string; output: string; created?: Date;
}): Promise<void> {
  const { repository, source, directory, output } = options;
  const manifest = record(JSON.parse(await readFile(join(directory, 'release.json'), 'utf8')), 'the release manifest');
  const version = text(manifest.version, 'release version');
  const sourceSha = text(manifest.source, 'release source');
  // The SBOM describes the tree exactly as staged: every file present and matching its checksum.
  await verifyReleaseDirectory(directory, sourceSha, version);
  const pkg = record(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')), 'the release package');
  const sourcePackage = record(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')), 'the source package');
  const sbom = createSbom({
    repository,
    name: text(pkg.name, 'release package name'),
    license: text(sourcePackage.license, 'source license'),
    version,
    sourceSha,
    bundled: parseBundled(JSON.parse(await readFile(join(source, 'third-party-licenses.json'), 'utf8'))),
    lock: JSON.parse(await readFile(join(source, 'package-lock.json'), 'utf8')),
    notices: await readFile(join(directory, NOTICES_FILE), 'utf8'),
    created: options.created ?? new Date(),
  });
  await writeFile(output, `${JSON.stringify(sbom, null, 2)}\n`, { flag: 'wx' });
}

// Run from the source checkout, like prepare.ts.
if (import.meta.main) {
  const [repository, directory, output] = process.argv.slice(2);
  if (!repository || !directory || !output) throw new Error('Usage: sbom.ts REPOSITORY RELEASE_DIRECTORY OUTPUT_FILE');
  await writeSbom({ repository, source: process.cwd(), directory: resolve(directory), output: resolve(output) });
}

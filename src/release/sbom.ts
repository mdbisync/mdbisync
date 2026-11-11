// Writes the SPDX 2.3 SBOM of a staged public release: the release package
// and every third-party package bundled into it.
//
// The bundled packages come from the license inventory, which the build has
// just checked against the bundles (it fails on any package bundled but not
// listed, or listed but not bundled). Each one must also have a section in
// the release tree's notices, so the SBOM describes the tree it ships with.
// Download locations and checksums come from the lockfile the build
// installed from. Like the other release scripts, this needs only Node.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { INVENTORY_FILE, parseInventory, type InventoryEntry } from '../../tools/licenses.ts';
import { NOTICES_FILE, noticeTitle, record, validateSha, validateVersion, verifyReleaseDirectory } from './package.ts';

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`Missing ${what}`);
  return value;
}

/** Finds the one download location and integrity hash the lockfile gives a package version. */
export function lockedSource(lock: unknown, entry: InventoryEntry): { resolved: string; integrity: string } {
  const packages = record(record(lock).packages) as Record<string, { version?: string; resolved?: string; integrity?: string }>;
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
  bundled: readonly InventoryEntry[]; lock: unknown; notices: string; created: Date; documentId?: string;
}): Record<string, unknown> {
  const { repository, name, license, version, sourceSha, bundled, lock, notices } = options;
  validateVersion(version);
  validateSha(sourceSha);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Expected a repository such as owner/name');
  if (bundled.length === 0) throw new Error('The license inventory must list the bundled packages');
  const root = 'SPDXRef-Package-release';
  const packages = bundled.map((entry) => {
    if (!notices.includes(`\n${noticeTitle(entry)}\n`)) {
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
      // Declared by the package; the build checks it against an allow-list, but makes no license conclusion of its own.
      licenseConcluded: 'NOASSERTION',
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
    // Unique per document, as SPDX requires: a rerun of the same release writes a new document.
    documentNamespace: `https://github.com/${repository}/spdx/${version}-${sourceSha}-${options.documentId ?? randomUUID()}`,
    creationInfo: { created: options.created.toISOString().replace(/\.\d{3}Z$/, 'Z'), creators: [`Tool: ${name}-release-sbom`] },
    packages: [
      {
        SPDXID: root,
        name,
        versionInfo: version.slice(1),
        downloadLocation: `git+https://github.com/${repository}.git@${version}`,
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
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
  repository: string; sourceSha: string; version: string; source: string; directory: string; output: string; created?: Date;
}): Promise<void> {
  const { repository, sourceSha, version, source, directory, output } = options;
  // The SBOM describes the tree exactly as staged for this source and version: every file present and matching its checksum.
  await verifyReleaseDirectory(directory, sourceSha, version);
  const pkg = record(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')));
  const sourcePackage = record(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')));
  const sbom = createSbom({
    repository,
    name: text(pkg.name, 'release package name'),
    license: text(sourcePackage.license, 'source license'),
    version,
    sourceSha,
    bundled: parseInventory(await readFile(join(source, INVENTORY_FILE), 'utf8')),
    lock: JSON.parse(await readFile(join(source, 'package-lock.json'), 'utf8')),
    notices: await readFile(join(directory, NOTICES_FILE), 'utf8'),
    created: options.created ?? new Date(),
  });
  await writeFile(output, `${JSON.stringify(sbom, null, 2)}\n`, { flag: 'wx' });
}

// Run from the source checkout, like prepare.ts, which it must still match.
if (import.meta.main) {
  const [repository, sourceSha, version, directory, output] = process.argv.slice(2);
  if (!repository || !sourceSha || !version || !directory || !output) {
    throw new Error('Usage: sbom.ts REPOSITORY SOURCE_SHA VERSION RELEASE_DIRECTORY OUTPUT_FILE');
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== sourceSha) throw new Error('Source SHA must match the checked-out source');
  execFileSync('git', ['diff', '--exit-code', 'HEAD', '--'], { stdio: 'pipe' });
  await writeSbom({ repository, sourceSha, version, source: process.cwd(), directory: resolve(directory), output: resolve(output) });
}

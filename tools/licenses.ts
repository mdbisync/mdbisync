// License check for the third-party packages bundled into dist/.
//
// Every package whose code ends up in a bundle must be listed in
// third-party-licenses.json with its exact version and license, and that
// license must be on the allow-list below. The build also writes the
// license texts and notices of those packages to dist/THIRD_PARTY_NOTICES.txt,
// which the release ships next to the bundles.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Metafile } from "esbuild";
import { NOTICES_FILE, noticeTitle } from "../src/release/package.ts";
import { packagePathOf } from "./lockfile.ts";

export { NOTICES_FILE };
export const INVENTORY_FILE = "third-party-licenses.json";

// Permissive licenses compatible with distributing the bundles under MIT.
export const ALLOWED_LICENSES: ReadonlySet<string> = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0"]);

export interface InventoryEntry {
  readonly name: string;
  readonly version: string;
  readonly license: string;
}

export interface BundledPackage extends InventoryEntry {
  readonly path: string;
  // License, copying and notice files shipped in the package, by file name.
  readonly noticeFiles: readonly { readonly file: string; readonly text: string }[];
}

// Packages with at least one byte of code in some bundle; modules that
// tree shaking dropped entirely do not count.
export function bundledPackagePaths(metafile: Metafile): string[] {
  const paths = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      const path = packagePathOf(input);
      if (path !== undefined && bytesInOutput > 0) {
        paths.add(path);
      }
    }
  }
  return [...paths].sort();
}

// Only a single allowed SPDX identifier passes. A compound expression
// (dual licensing, "A AND B") fails, so that admitting such a package is an
// explicit decision that also records which license applies.
export function licenseAllowed(expression: string): boolean {
  return ALLOWED_LICENSES.has(expression);
}

const NOTICE_FILE = /^(?:licen[cs]e|copying|notice)(?:[-._].*)?$/i;
// A NOTICE file alone carries no license text; the check needs one of these.
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[-._].*)?$/i;

export function readBundledPackage(path: string): BundledPackage {
  const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
    license?: unknown;
  };
  // Subfolders count too: a package may carry vendored code under its own
  // license (undici's lib/web/fetch/LICENSE). Nested packages are separate.
  const noticeFiles = readdirSync(path, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && NOTICE_FILE.test(entry.name))
    .map((entry) => relative(path, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((file) => !file.split("/").includes("node_modules"))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(path, file), "utf8") }));
  return {
    path,
    name: typeof manifest.name === "string" ? manifest.name : "",
    version: typeof manifest.version === "string" ? manifest.version : "",
    // Only an SPDX string counts; legacy objects and arrays are reported.
    license: typeof manifest.license === "string" ? manifest.license : "",
    noticeFiles,
  };
}

export function entryKey(entry: Pick<InventoryEntry, "name" | "version">): string {
  return `${entry.name}@${entry.version}`;
}

// One package per name and version, sorted: the same version installed at
// two paths is one package for licensing.
export function uniquePackages(packages: readonly BundledPackage[]): BundledPackage[] {
  const unique = new Map(packages.map((pkg) => [entryKey(pkg), pkg]));
  return [...unique.values()].sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
}

export function inventoryOf(packages: readonly BundledPackage[]): InventoryEntry[] {
  return uniquePackages(packages).map(({ name, version, license }) => ({ name, version, license }));
}

export function parseInventory(text: string): InventoryEntry[] {
  const value = JSON.parse(text) as unknown;
  if (!Array.isArray(value)) {
    throw new Error(`${INVENTORY_FILE} must be a JSON array`);
  }
  return value.map((item: unknown) => {
    const entry = item as Partial<Record<keyof InventoryEntry, unknown>>;
    if (typeof entry.name !== "string" || typeof entry.version !== "string" || typeof entry.license !== "string") {
      throw new Error(`${INVENTORY_FILE} entries need string name, version and license`);
    }
    return { name: entry.name, version: entry.version, license: entry.license };
  });
}

export function formatInventory(entries: readonly InventoryEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

// Returns one line per problem; an empty list means the check passes.
export function findLicenseProblems(packages: readonly BundledPackage[], inventory: readonly InventoryEntry[]): string[] {
  const problems: string[] = [];
  const listed = new Map(inventory.map((entry) => [entryKey(entry), entry]));
  const bundled = new Set<string>();
  for (const pkg of uniquePackages(packages)) {
    const key = entryKey(pkg);
    bundled.add(key);
    if (pkg.name === "" || pkg.version === "") {
      problems.push(`${pkg.path}: package.json has no name or version`);
      continue;
    }
    if (pkg.license === "") {
      problems.push(`${key}: no SPDX license in package.json`);
    } else if (!licenseAllowed(pkg.license)) {
      problems.push(`${key}: license ${pkg.license} is not allowed`);
    }
    if (!pkg.noticeFiles.some(({ file }) => LICENSE_FILE.test(file.split("/").at(-1) ?? ""))) {
      problems.push(`${key}: no license file to reproduce in the notices`);
    }
    const entry = listed.get(key);
    if (entry === undefined) {
      problems.push(`${key}: bundled but missing from ${INVENTORY_FILE}`);
    } else if (entry.license !== pkg.license) {
      problems.push(`${key}: ${INVENTORY_FILE} says ${entry.license}, package.json says ${pkg.license}`);
    }
  }
  for (const key of listed.keys()) {
    if (!bundled.has(key)) {
      problems.push(`${key}: listed in ${INVENTORY_FILE} but not bundled`);
    }
  }
  return problems;
}

export function formatNotices(packages: readonly BundledPackage[]): string {
  const rule = "=".repeat(78);
  const sections = uniquePackages(packages).map((pkg) => {
    const texts = pkg.noticeFiles.map(({ file, text }) => `--- ${file} ---\n\n${text.trimEnd()}\n`);
    return `${rule}\n${noticeTitle(pkg)}\n${rule}\n\n${texts.join("\n")}`;
  });
  const header = [
    "Third-party software notices",
    "",
    "The bundled files in this directory include the following third-party",
    "packages. Each is listed with its version, its license and the license",
    "and notice files it ships. Notices embedded in individual source files",
    "are kept in the *.LEGAL.txt files next to the bundles.",
    "",
  ].join("\n");
  return `${header}\n${sections.join("\n")}`;
}

export function formatPackageList(entries: readonly InventoryEntry[]): string {
  return entries
    .map(({ name, version, license }) => `  ${name} ${version} ${license}`)
    .join("\n");
}

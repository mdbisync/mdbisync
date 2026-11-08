import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Metafile } from "esbuild";
import {
  INVENTORY_FILE,
  bundledPackagePaths,
  findLicenseProblems,
  formatInventory,
  formatNotices,
  inventoryOf,
  licenseAllowed,
  parseInventory,
  readBundledPackage,
  type BundledPackage,
} from "./licenses.ts";

function bundled(name: string, license: string, version = "1.0.0"): BundledPackage {
  return { path: `node_modules/${name}`, name, version, license, noticeFiles: [{ file: "LICENSE", text: `${license} text for ${name}\n` }] };
}

test("allowed licenses: single identifiers and flat OR or AND expressions", () => {
  for (const license of ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "(MIT OR GPL-3.0)", "MIT AND ISC"]) {
    assert.equal(licenseAllowed(license), true, license);
  }
  for (const license of ["GPL-3.0", "LGPL-2.1", "UNLICENSED", "SEE LICENSE IN LICENSE", "", "MIT AND GPL-3.0", "(MIT OR ISC) AND GPL-3.0"]) {
    assert.equal(licenseAllowed(license), false, license);
  }
});

test("only packages with code in a bundle count as bundled", () => {
  const metafile = {
    inputs: {},
    outputs: {
      "dist/cli.js": {
        bytes: 1,
        imports: [],
        exports: [],
        inputs: {
          "src/cli.ts": { bytesInOutput: 10 },
          "node_modules/a/index.js": { bytesInOutput: 5 },
          "node_modules/a/node_modules/@s/b/index.js": { bytesInOutput: 3 },
          "node_modules/shaken/index.js": { bytesInOutput: 0 },
        },
      },
    },
  } satisfies Metafile;
  assert.deepEqual(bundledPackagePaths(metafile), ["node_modules/a", "node_modules/a/node_modules/@s/b"]);
});

test("a bundled package with a license outside the allow-list fails the check", () => {
  const packages = [bundled("good", "MIT"), bundled("copyleft", "GPL-3.0")];
  assert.deepEqual(findLicenseProblems(packages, inventoryOf(packages)), ["copyleft@1.0.0: license GPL-3.0 is not allowed"]);
});

test("a bundled package missing from the inventory fails the check", () => {
  const packages = [bundled("listed", "MIT"), bundled("unlisted", "ISC")];
  assert.deepEqual(findLicenseProblems(packages, inventoryOf([packages[0]!])), [
    `unlisted@1.0.0: bundled but missing from ${INVENTORY_FILE}`,
  ]);
});

test("a version bump, a license change or a stale entry fails the check", () => {
  const inventory = [
    { name: "bumped", version: "1.0.0", license: "MIT" },
    { name: "relicensed", version: "1.0.0", license: "MIT" },
    { name: "gone", version: "1.0.0", license: "MIT" },
  ];
  const packages = [bundled("bumped", "MIT", "1.1.0"), bundled("relicensed", "ISC")];
  assert.deepEqual(findLicenseProblems(packages, inventory), [
    `bumped@1.1.0: bundled but missing from ${INVENTORY_FILE}`,
    `relicensed@1.0.0: ${INVENTORY_FILE} says MIT, package.json says ISC`,
    `bumped@1.0.0: listed in ${INVENTORY_FILE} but not bundled`,
    `gone@1.0.0: listed in ${INVENTORY_FILE} but not bundled`,
  ]);
});

test("a package without a license field or license file fails the check", () => {
  const packages = [{ ...bundled("no-field", ""), license: "" }, { ...bundled("no-file", "MIT"), noticeFiles: [] }];
  assert.deepEqual(findLicenseProblems(packages, inventoryOf(packages)), [
    "no-field@1.0.0: no SPDX license in package.json",
    "no-file@1.0.0: no license file to reproduce in the notices",
  ]);
});

test("package facts and license files are read from the package folder", () => {
  const root = mkdtempSync(join(tmpdir(), "licenses-"));
  try {
    const path = join(root, "node_modules", "pkg");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify({ name: "pkg", version: "2.0.0", license: "Apache-2.0" }));
    writeFileSync(join(path, "LICENSE"), "Apache license text\n");
    writeFileSync(join(path, "NOTICE"), "Required notice\n");
    writeFileSync(join(path, "index.js"), "export {};\n");
    mkdirSync(join(path, "lib", "vendored"), { recursive: true });
    writeFileSync(join(path, "lib", "vendored", "LICENSE"), "Vendored code license\n");
    mkdirSync(join(path, "node_modules", "nested"), { recursive: true });
    writeFileSync(join(path, "node_modules", "nested", "LICENSE"), "A separate package\n");
    const pkg = readBundledPackage(path);
    assert.equal(pkg.name, "pkg");
    assert.equal(pkg.license, "Apache-2.0");
    assert.deepEqual(pkg.noticeFiles.map(({ file }) => file), ["LICENSE", "NOTICE", "lib/vendored/LICENSE"]);
    assert.match(formatNotices([pkg]), /--- lib\/vendored\/LICENSE ---\n\nVendored code license/);
    const notices = formatNotices([pkg]);
    assert.match(notices, /pkg 2\.0\.0\nLicense: Apache-2\.0/);
    assert.match(notices, /Apache license text/);
    assert.match(notices, /Required notice/);
    writeFileSync(join(path, "package.json"), JSON.stringify({ name: "pkg", version: "2.0.0", license: { type: "MIT" } }));
    assert.equal(readBundledPackage(path).license, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the inventory round-trips and the committed one lists only allowed licenses", () => {
  const entries = inventoryOf([bundled("b", "ISC"), bundled("a", "MIT"), bundled("a", "MIT")]);
  assert.deepEqual(parseInventory(formatInventory(entries)), [
    { name: "a", version: "1.0.0", license: "MIT" },
    { name: "b", version: "1.0.0", license: "ISC" },
  ]);
  assert.throws(() => parseInventory("{}"), /JSON array/);
  const committed = parseInventory(readFileSync(INVENTORY_FILE, "utf8"));
  assert.ok(committed.length > 0);
  for (const entry of committed) {
    assert.equal(licenseAllowed(entry.license), true, `${entry.name}@${entry.version}`);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Metafile } from "esbuild";
import { findDevPackagesInBundle } from "./build.ts";
import { findInstallScripts } from "./check-install-scripts.ts";
import { findCyrillicLines } from "./check-no-cyrillic.ts";
import { packagePathOf, parseLockfile, readLockfile } from "./lockfile.ts";

const lock = parseLockfile(
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { name: "root" },
      "node_modules/runtime-lib": { version: "1.0.0" },
      "node_modules/dev-lib": { version: "1.0.0", dev: true },
      "node_modules/dev-optional-lib": { version: "1.0.0", devOptional: true },
      "node_modules/@scope/scripted": { version: "2.0.0", dev: true, hasInstallScript: true },
    },
  }),
);

test("install scripts are reported unless allowed by name and exact version", () => {
  assert.deepEqual(findInstallScripts(lock, new Map()), ["node_modules/@scope/scripted@2.0.0"]);
  assert.deepEqual(findInstallScripts(lock, new Map([["node_modules/@scope/scripted@2.0.0", "reason"]])), []);
  assert.deepEqual(findInstallScripts(lock, new Map([["node_modules/@scope/scripted@1.9.0", "reason"]])), ["node_modules/@scope/scripted@2.0.0"]);
});

test("the committed lock file passes the install-script check", () => {
  assert.deepEqual(findInstallScripts(readLockfile()), []);
});

test("package paths are found for plain, scoped and nested modules", () => {
  assert.equal(packagePathOf("node_modules/a/lib/x.js"), "node_modules/a");
  assert.equal(packagePathOf("node_modules/@s/b/index.js"), "node_modules/@s/b");
  assert.equal(packagePathOf("node_modules/a/node_modules/@s/c/x.js"), "node_modules/a/node_modules/@s/c");
  assert.equal(packagePathOf("src/cli.ts"), undefined);
});

test("development-only packages in a bundle are reported", () => {
  const metafile = {
    inputs: {},
    outputs: {
      "dist/cli.js": {
        bytes: 1,
        imports: [],
        exports: [],
        entryPoint: "src/cli.ts",
        inputs: { "src/cli.ts": { bytesInOutput: 1 }, "node_modules/runtime-lib/x.js": { bytesInOutput: 1 }, "node_modules/dev-lib/y.js": { bytesInOutput: 1 }, "node_modules/dev-optional-lib/z.js": { bytesInOutput: 1 } },
      },
    },
  } satisfies Metafile;
  assert.deepEqual(findDevPackagesInBundle(metafile, lock), ["node_modules/dev-lib", "node_modules/dev-optional-lib"]);
});

test("Cyrillic characters are found by line", () => {
  const cyrillicWord = String.fromCodePoint(0x43f, 0x440, 0x438, 0x432, 0x435, 0x442);
  assert.deepEqual(findCyrillicLines(`plain\nGreek αβγ and CJK 漢字\nsay ${cyrillicWord}\n`), [3]);
  assert.deepEqual(findCyrillicLines("no hits here"), []);
});

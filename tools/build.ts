// Bundles each entry point into one self-contained file under dist/, then
// checks that no development-only package ended up in a bundle.

import { rmSync } from "node:fs";
import { build, type Metafile } from "esbuild";
import { readLockfile, packagePathOf, type LockedPackage } from "./lockfile.ts";

export const ENTRY_POINTS = {
  cli: "src/cli.ts",
  "action-main": "src/action/main.ts",
  "action-post": "src/action/post.ts",
} as const;

export function findDevPackagesInBundle(metafile: Metafile, packages: readonly LockedPackage[]): string[] {
  const devPaths = new Set(packages.filter((pkg) => pkg.dev).map((pkg) => pkg.path));
  const bundled = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const input of Object.keys(output.inputs)) {
      const path = packagePathOf(input);
      if (path !== undefined && devPaths.has(path)) {
        bundled.add(path);
      }
    }
  }
  return [...bundled].sort();
}

async function main(): Promise<void> {
  rmSync("dist", { recursive: true, force: true }); // no stale bundles
  const result = await build({
    entryPoints: ENTRY_POINTS,
    outdir: "dist",
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    // Some bundled CommonJS packages call require(); give the ES module bundle one.
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    define: {
      __MDBISYNC_RELEASE_VERSION__: process.env["MDBISYNC_RELEASE_VERSION"] === undefined
        ? "undefined" : JSON.stringify(process.env["MDBISYNC_RELEASE_VERSION"]),
    },
    metafile: true,
    legalComments: "linked",
    logLevel: "warning",
  });
  const devPackages = findDevPackagesInBundle(result.metafile, readLockfile());
  if (devPackages.length > 0) {
    console.error(`Development-only packages in a bundle:\n${devPackages.map((path) => `  ${path}`).join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Built ${Object.keys(ENTRY_POINTS).length} bundles in dist/.`);
}

if (import.meta.main) {
  await main();
}

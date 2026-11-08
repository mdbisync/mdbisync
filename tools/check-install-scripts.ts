// Fails when a locked package declares an install script.
// Install scripts never run (`ignore-scripts=true` in .npmrc); this check
// keeps packages that depend on them out of the tree.

import { readLockfile, type LockedPackage } from "./lockfile.ts";

// Packages whose install script is known and not needed, keyed by path and
// exact version so that an update has to be looked at again. Each entry says why.
export const ALLOWED_INSTALL_SCRIPTS: ReadonlyMap<string, string> = new Map([
  [
    "node_modules/esbuild@0.28.2",
    "build-time only; its postinstall only verifies the platform binary, which npm installs as an optional dependency, so it works with scripts off",
  ],
]);

export function findInstallScripts(packages: readonly LockedPackage[], allowed: ReadonlyMap<string, string> = ALLOWED_INSTALL_SCRIPTS): string[] {
  return packages.filter((pkg) => pkg.hasInstallScript && !allowed.has(`${pkg.path}@${pkg.version}`)).map((pkg) => `${pkg.path}@${pkg.version}`);
}

if (import.meta.main) {
  const offending = findInstallScripts(readLockfile());
  if (offending.length > 0) {
    console.error(`Locked packages with an install script:\n${offending.map((path) => `  ${path}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("No locked package has an install script outside the allow-list.");
  }
}

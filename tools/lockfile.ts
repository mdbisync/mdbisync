// Reads the facts the supply-chain checks need from package-lock.json.

import { readFileSync } from "node:fs";

export interface LockedPackage {
  readonly path: string;
  readonly version: string;
  // Installed only for development: `dev`, or `devOptional` (a dev-only
  // package that some dependency also lists as optional).
  readonly dev: boolean;
  readonly hasInstallScript: boolean;
}

interface LockfileJson {
  readonly lockfileVersion?: number;
  readonly packages?: Record<string, { version?: string; dev?: boolean; devOptional?: boolean; hasInstallScript?: boolean }>;
}

export function parseLockfile(text: string): LockedPackage[] {
  const lock = JSON.parse(text) as LockfileJson;
  if (lock.lockfileVersion !== 3 || lock.packages === undefined) {
    throw new Error("package-lock.json must use lockfileVersion 3");
  }
  return Object.entries(lock.packages)
    .filter(([path]) => path !== "")
    .map(([path, entry]) => ({
      path,
      version: entry.version ?? "",
      dev: entry.dev === true || entry.devOptional === true,
      hasInstallScript: entry.hasInstallScript === true,
    }));
}

export function readLockfile(file = "package-lock.json"): LockedPackage[] {
  return parseLockfile(readFileSync(file, "utf8"));
}

// "node_modules/a/node_modules/@b/c/lib/x.js" -> "node_modules/a/node_modules/@b/c"
export function packagePathOf(file: string): string | undefined {
  const parts = file.split("/");
  const index = parts.lastIndexOf("node_modules");
  if (index === -1 || index + 1 >= parts.length) {
    return undefined;
  }
  const scoped = parts[index + 1]?.startsWith("@") === true;
  return parts.slice(0, index + (scoped ? 3 : 2)).join("/");
}

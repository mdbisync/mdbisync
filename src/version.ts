import packageJson from "../package.json" with { type: "json" };

/** The project's repository: the action, the pre-commit hooks and the docs. */
export const PROJECT_URL = "https://github.com/mdbisync/mdbisync";

declare const __MDBISYNC_RELEASE_VERSION__: string | undefined;

export const VERSION: string = typeof __MDBISYNC_RELEASE_VERSION__ === "string"
  ? __MDBISYNC_RELEASE_VERSION__ : packageJson.version;

/**
 * Whether `version` is a release older than `than`, as semantic versions order them (`1.0.1-rc.7` before
 * `1.0.1-rc.8` before `1.0.1`). A missing version is older than any; one in another form is never older.
 */
export function olderVersion(version: string | undefined, than: string): boolean {
  if (version === undefined) return true;
  const a = parseVersion(version);
  const b = parseVersion(than);
  if (a === undefined || b === undefined) return false;
  for (let index = 0; index < 3; index++) if (a.core[index] !== b.core[index]) return a.core[index]! < b.core[index]!;
  // A pre-release comes before its release.
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length > 0 && b.pre.length === 0;
  for (let index = 0; index < Math.min(a.pre.length, b.pre.length); index++) {
    const [x, y] = [a.pre[index]!, b.pre[index]!];
    if (x === y) continue;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny) return Number(x) < Number(y);
    // Numeric identifiers come before alphanumeric ones.
    if (nx !== ny) return nx;
    return x < y;
  }
  return a.pre.length < b.pre.length;
}

function parseVersion(version: string): { core: number[]; pre: string[] } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (match === null) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] === undefined ? [] : match[4].split('.') };
}

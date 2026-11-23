import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { message } from '../messages.ts';
import { type PathRule } from '../codes.ts';
import { isGitDirectoryName } from '../state/objects.ts';
import { inAssetsFolder } from '../format/lint.ts';

/**
 * The name of the rule `titlePath` and `documentPath` follow, as run
 * reports give it: a document read from Linear gets the same file name in a
 * sync's capture and in an initial sync from Linear.
 */
export const PATH_RULE = 'percent-encode-unsafe-segments' satisfies PathRule;

const escapeFirst = (text: string) => text === '' ? '%00' : `%${text.charCodeAt(0).toString(16).toUpperCase()}${text.slice(1)}`;

/**
 * Keeps a name below common file-system byte limits: a longer one becomes its first 40 characters and a hash of
 * `source`. The shortened name is checked again, since without the code points HFS+ ignores, `git` and a hash of
 * digits read as the Git directory's short name `git~<n>`.
 */
function shorten(name: string, source: string): string {
  if (Buffer.byteLength(name) <= 180) return name;
  const short = `${[...name].slice(0, 40).join('')}~${createHash('sha256').update(source).digest('hex').slice(0, 16)}`;
  return isGitDirectoryName(short) ? escapeFirst(short) : short;
}

/** Titles are slash paths. Encode unsafe segments without allowing traversal or platform aliases. */
export function titlePath(title: string): string {
  return title.normalize('NFC').split('/').map((part) => {
    let safe = part.replace(/[%\\\u0000-\u001f\u007f:*?"<>|]/g, (char) => char === '*' ? '%2A' : encodeURIComponent(char));
    if (safe === '' || safe === '.' || safe === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = escapeFirst(safe);
    safe = safe.replace(/[. ]+$/, (suffix) => [...suffix].map((char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).join(''));
    // Checked after the trailing dots and spaces are encoded, so `.git.` keeps its earlier name `.git%2E`.
    if (isGitDirectoryName(safe) || safe.toLowerCase() === '.github') safe = escapeFirst(safe);
    return shorten(safe, part);
  }).join('/');
}

/**
 * A name in the folder. Command-line tools, pre-commit among them, read a path that starts with `-` as an
 * option, so a name at the repository root never starts with one; a folder's own name is the mapping's.
 */
function inFolder(folder: string, name: string): string { return folder === '' && name.startsWith('-') ? `%2D${name.slice(1)}` : posix.join(folder, name); }

/** The name a document with an empty title gets: Linear keeps a new document untitled until one is typed. */
export const UNTITLED = 'Untitled';

/** Whether a title is empty or only white space, and so names no file of its own. */
export function isUntitled(title: string): boolean { return title.normalize('NFC').trim() === ''; }

/** The title a document's file is named after: `Untitled` for an empty one. */
export function fileTitle(title: string): string { return isUntitled(title) ? UNTITLED : title; }

/** The file a title names in a folder, before any collision suffix. */
export function titleFile(folder: string, title: string): string { return `${inFolder(folder, titlePath(fileTitle(title)))}.md`; }

export function pathKey(path: string): string { return path.normalize('NFC').toLowerCase(); }

/** Whether a path lands on an occupied path, its ancestor or descendant, an `assets` folder, or an invalid place. */
function conflictsIn(folder: string, occupied: ReadonlySet<string>, invalid: (path: string) => boolean): (path: string) => boolean {
  const keys = [...occupied].map(pathKey);
  // A title must not place its document inside an `assets` folder below the annotated folder: the sync keeps
  // embedded files there, and lint refuses documents in it. Such a title is flattened like a taken one.
  const inAssets = (path: string) => inAssetsFolder(folder === '' ? path : path.slice(folder.length + 1));
  return (path) => inAssets(path) || invalid(path) || keys.some((key) => key === pathKey(path) || key.startsWith(`${pathKey(path)}/`) || pathKey(path).startsWith(`${key}/`));
}

/** A path that would be read as an option or names the Git directory. */
const unsafe = (folder: string, path: string) => (folder === '' && path.startsWith('-')) || path.split('/').some(isGitDirectoryName);

/** The name earlier versions gave a document with an empty title: `%00.md`, or that name with a collision suffix. */
const ENCODED_EMPTY = /^%00(?:~[0-9a-f]{12}(?:-\d+)?)?\.md$/;

/**
 * The path a document whose title was cleared keeps: an empty title names no file, so the file it has stays, unless
 * that path is no longer safe or free, or is the encoded empty name earlier versions gave untitled documents.
 */
export function keptPath(folder: string, occupied: ReadonlySet<string>, previous: string, invalid: (path: string) => boolean = () => false): string | undefined {
  if (conflictsIn(folder, occupied, invalid)(previous) || unsafe(folder, previous) || ENCODED_EMPTY.test(posix.basename(previous))) return undefined;
  return previous;
}

/** Never overwrite an existing file, directory, or case-insensitive alias. */
export function documentPath(folder: string, documentTitle: string, id: string, occupied: ReadonlySet<string>, previous?: string, invalid: (path: string) => boolean = () => false): string {
  const title = fileTitle(documentTitle);
  const conflicts = conflictsIn(folder, occupied, invalid);
  let candidate = titleFile(folder, title);
  // An existing git-originated spelling already represents this title,
  // unless it would be read as an option or names the Git directory.
  const raw = `${folder === '' ? '' : `${folder}/`}${title}.md`;
  if (previous === raw && !conflicts(previous) && !unsafe(folder, previous)) return previous;
  const suffix = createHash('sha256').update(id).digest('hex').slice(0, 12);
  // A conflicting ancestor may be a file; flatten the title in that case.
  const flattened = titlePath(title).replaceAll('/', '%2F');
  const flat = shorten(flattened, title);
  if (previous !== undefined && !conflicts(previous)) {
    const prefix = inFolder(folder, `${flat}~${suffix}`);
    if (previous === `${prefix}.md` || (previous.startsWith(`${prefix}-`) && /^\d+\.md$/.test(previous.slice(prefix.length + 1)))) return previous;
  }
  if (!conflicts(candidate)) return candidate;
  for (let index = 0; ; index += 1) {
    candidate = inFolder(folder, `${flat}~${suffix}${index === 0 ? '' : `-${index}`}.md`);
    if (!conflicts(candidate)) return candidate;
    if (index > occupied.size + 1) throw new Error(message('sync.no-safe-path'));
  }
}

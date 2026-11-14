import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { message } from '../messages.ts';
import { type PathRule } from '../codes.ts';

/**
 * The name of the rule `titlePath` and `documentPath` follow, as run
 * reports give it: a document read from Linear gets the same file name in a
 * sync's capture and in an initial sync from Linear.
 */
export const PATH_RULE = 'percent-encode-unsafe-segments' satisfies PathRule;

/** Titles are slash paths. Encode unsafe segments without allowing traversal or platform aliases. */
export function titlePath(title: string): string {
  return title.normalize('NFC').split('/').map((part) => {
    let safe = part.replace(/[%\\\u0000-\u001f\u007f:*?"<>|]/g, (char) => char === '*' ? '%2A' : encodeURIComponent(char));
    if (safe === '' || safe === '.' || safe === '..' || safe.toLowerCase() === '.git' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) {
      safe = safe === '' ? '%00' : `%${safe.charCodeAt(0).toString(16).toUpperCase()}${safe.slice(1)}`;
    }
    safe = safe.replace(/[. ]+$/, (suffix) => [...suffix].map((char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).join(''));
    // Keep every segment below common file-system byte limits.
    if (Buffer.byteLength(safe) > 180) safe = `${[...safe].slice(0, 40).join('')}~${createHash('sha256').update(part).digest('hex').slice(0, 16)}`;
    return safe;
  }).join('/');
}

/**
 * A name in the folder. Command-line tools, pre-commit among them, read a path that starts with `-` as an
 * option, so a name at the repository root never starts with one; a folder's own name is the mapping's.
 */
function inFolder(folder: string, name: string): string { return folder === '' && name.startsWith('-') ? `%2D${name.slice(1)}` : posix.join(folder, name); }

/** The file a title names in a folder, before any collision suffix. */
export function titleFile(folder: string, title: string): string { return `${inFolder(folder, titlePath(title))}.md`; }

export function pathKey(path: string): string { return path.normalize('NFC').toLowerCase(); }

/** Never overwrite an existing file, directory, or case-insensitive alias. */
export function documentPath(folder: string, title: string, id: string, occupied: ReadonlySet<string>, previous?: string, invalid: (path: string) => boolean = () => false): string {
  const keys = [...occupied].map(pathKey);
  const conflicts = (path: string) => invalid(path) || keys.some((key) => key === pathKey(path) || key.startsWith(`${pathKey(path)}/`) || pathKey(path).startsWith(`${key}/`));
  let candidate = titleFile(folder, title);
  // An existing git-originated spelling already represents this title.
  const raw = `${folder === '' ? '' : `${folder}/`}${title}.md`;
  if (previous === raw && !conflicts(previous) && !(folder === '' && raw.startsWith('-'))) return previous;
  const suffix = createHash('sha256').update(id).digest('hex').slice(0, 12);
  // A conflicting ancestor may be a file; flatten the title in that case.
  const flattened = titlePath(title).replaceAll('/', '%2F');
  const flat = Buffer.byteLength(flattened) > 180 ? `${[...flattened].slice(0, 40).join('')}~${createHash('sha256').update(title).digest('hex').slice(0, 16)}` : flattened;
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

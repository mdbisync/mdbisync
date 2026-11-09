import { createHash } from 'node:crypto';
import { posix } from 'node:path';

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

export function pathKey(path: string): string { return path.normalize('NFC').toLowerCase(); }

/** Never overwrite an existing file, directory, or case-insensitive alias. */
export function documentPath(folder: string, title: string, id: string, occupied: ReadonlySet<string>): string {
  const stem = posix.join(folder, titlePath(title));
  const keys = [...occupied].map(pathKey);
  const conflicts = (path: string) => keys.some((key) => key === pathKey(path) || key.startsWith(`${pathKey(path)}/`) || pathKey(path).startsWith(`${key}/`));
  let candidate = `${stem}.md`;
  if (!conflicts(candidate)) return candidate;
  const suffix = createHash('sha256').update(id).digest('hex').slice(0, 12);
  // A conflicting ancestor may be a file; flatten the title in that case.
  const flattened = titlePath(title).replaceAll('/', '%2F');
  const flat = Buffer.byteLength(flattened) > 180 ? `${[...flattened].slice(0, 40).join('')}~${createHash('sha256').update(title).digest('hex').slice(0, 16)}` : flattened;
  for (let index = 0; ; index += 1) {
    candidate = posix.join(folder, `${flat}~${suffix}${index === 0 ? '' : `-${index}`}.md`);
    if (!conflicts(candidate)) return candidate;
    if (index > occupied.size + 1) throw new Error('no safe destination for a document');
  }
}

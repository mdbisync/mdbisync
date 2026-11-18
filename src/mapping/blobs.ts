import { CONTENT_LIMIT } from '../format/rules.ts';
import { message } from '../messages.ts';
import { type Git, type Oid } from '../state/git.ts';
import { type TreeEntry, readBlobs } from '../state/objects.ts';

// A Unicode code point can take up to four bytes in UTF-8.
export const MAPPING_FILE_BYTES = 4 * CONTENT_LIMIT;
export const MAPPING_TREE_BYTES = 16 * 1024 * 1024;
export const MAPPING_BUDGET_BYTES = 64 * 1024 * 1024;
const BATCH_BYTES = 4 * 1024 * 1024;

export class MappingBlobBudgetError extends Error {
  readonly code = 'mapping-blob-budget';

  constructor() {
    super(message('mapping.blob-budget', { bytes: MAPPING_BUDGET_BYTES }));
    this.name = 'MappingBlobBudgetError';
  }
}

export function readableBlob(entry: TreeEntry): entry is TreeEntry & { size: number } {
  return entry.size !== null && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= MAPPING_FILE_BYTES;
}

/** Charges each path before reading, including paths that share a blob but may be decoded separately. */
export class MappingBlobBudget {
  private remaining = MAPPING_BUDGET_BYTES;
  private readonly charged = new Set<TreeEntry>();
  private readonly cache = new Map<Oid, Buffer>();

  /** Reuse the same entry objects for each pass over the tree. */
  check(entries: readonly TreeEntry[]): void {
    for (const entry of entries) {
      if (!readableBlob(entry) || this.charged.has(entry)) continue;
      this.charged.add(entry);
      this.remaining -= entry.size;
      if (this.remaining < 0) throw new MappingBlobBudgetError();
    }
  }

  async read(git: Git, entries: readonly TreeEntry[]): Promise<Map<Oid, Buffer>> {
    this.check(entries);
    const unique = new Map<Oid, number>();
    for (const entry of entries) {
      if (!readableBlob(entry)) continue;
      // cat-file writes "<oid> blob <size>\n", the payload, and one final newline.
      unique.set(entry.oid, entry.oid.length + String(entry.size).length + 8 + entry.size);
    }
    let batch: Oid[] = [];
    let bytes = 0;
    const readBatch = async () => {
      for (const [oid, content] of await readBlobs(git, batch, bytes)) this.cache.set(oid, content);
      batch = [];
      bytes = 0;
    };
    for (const [oid, size] of unique) {
      if (this.cache.has(oid)) continue;
      if (bytes + size > BATCH_BYTES) await readBatch();
      batch.push(oid);
      bytes += size;
    }
    await readBatch();
    return new Map([...unique.keys()].map((oid) => [oid, this.cache.get(oid)!]));
  }
}

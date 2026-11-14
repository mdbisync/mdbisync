// Linear's answers to one run's reads, kept so that a later step of the same
// job can use them instead of reading Linear again. The staged security
// steps read Linear once per run this way: the stage step keeps the answers
// to its capture's reads (GraphQL queries and upload downloads), and the
// apply step's capture takes them, each once, in the order it asks; a read
// the stage step did not make goes to Linear. When the apply step's capture
// ends, the rest of its run reads Linear itself.
//
// The record holds answers only: never a request's headers, a token or an
// upload's signed address (reads are keyed by a hash of the request). It is
// an index file and one file per answer body, so a run with many large
// uploads never builds one large string.

import { ContentSpool, contentBytes, type SpooledFile } from '../state/content.ts';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type AuthContext, authMetadata } from './diagnostics.ts';

const VERSION = 2;
const INDEX = 'index.json';
const BODIES = 'bodies';

/** One kept answer: its status, its content type and its bytes. */
export interface KeptAnswer {
  status: number;
  type: string;
  body: Buffer;
}

interface ReadsIndex {
  version: number;
  /** The scopes and metadata of the stage step's token, for the apply step's setup check. */
  token: { scope: string[]; context: AuthContext } | null;
  /** In the order the stage step kept them; `body` names the body's file by its hash. */
  answers: Array<{ key: string; status: number; type: string; body: string }>;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** The key of a GraphQL request: its whole body (query, variables, operation name). */
export const graphqlReadKey = (body: string) => sha256(`graphql\n${body}`);
/** The key of an upload download: its address, which may carry a signature, never stored as such. */
export const uploadReadKey = (url: string) => sha256(`upload\n${url}`);

export class LinearReads {
  readonly mode: 'record' | 'replay';
  /** Kept answers by key, each key's in the order they were kept. */
  #answers = new Map<string, Array<{status: number; type: string; body: SpooledFile}>>();
  #spool = new ContentSpool(512 * 1024 * 1024, 8192);
  #order: string[] = [];
  #token: ReadsIndex['token'] = null;
  #ended = false;

  private constructor(mode: 'record' | 'replay') {
    this.mode = mode;
  }

  /** The stage step: keeps every answer it is given. */
  static recording(): LinearReads {
    return new LinearReads('record');
  }

  /**
   * The apply step: the stage step's record, or null when there is none it
   * can use (that step did not run, ran another version, or left the record
   * unfinished); the apply step then reads Linear itself.
   */
  static async replaying(folder: string): Promise<LinearReads | null> {
    try {
      const index = JSON.parse(await readFile(join(folder, INDEX), 'utf8')) as ReadsIndex;
      if (index.version !== VERSION || index.token === null || !Array.isArray(index.answers)) return null;
      const reads = new LinearReads('replay');
      reads.#token = index.token;
      if (index.answers.length > 8192) return null;
      let total = 0;
      for (const { key, status, type, body } of index.answers) {
        if (!/^[0-9a-f]{64}$/.test(body)) return null;
        const file = join(folder, BODIES, body);
        const size = (await stat(file)).size;
        total += size;
        if (total > 512 * 1024 * 1024) return null;
        const bytes = await readFile(file);
        if (sha256(bytes) !== body) return null;
        reads.#add(key, { status, type, body: {file, hash: body, size} });
      }
      return reads;
    } catch {
      return null;
    }
  }

  /** The stage step's token, as the apply step's setup check sees it; null while recording. */
  get token(): { scope: string[]; context: AuthContext } | null {
    return this.mode === 'replay' ? this.#token : null;
  }

  /** Records the scopes of the token the stage step reads with. */
  tokenMinted(scope: readonly string[], context: AuthContext): void {
    if (this.mode === 'record') this.#token = { scope: [...scope], context: authMetadata(context) as AuthContext };
  }

  /** The kept answer to this read, taken so it answers once; none while recording or after the capture ended. */
  take(key: string): KeptAnswer | undefined {
    if (this.mode !== 'replay' || this.#ended) return undefined;
    const answer = this.#answers.get(key)?.shift();
    return answer === undefined ? undefined : {...answer, body: contentBytes(answer.body)};
  }

  /** Keeps a successful answer while recording. */
  keep(key: string, answer: KeptAnswer): void {
    if (this.mode !== 'record' || this.#ended || answer.status < 200 || answer.status >= 300) return;
    this.#add(key, {...answer, body: this.#spool.put(answer.body)});
  }

  /** The capture ended: nothing more is kept or answered. */
  end(): void {
    this.#ended = true;
  }

  /** Writes the record into `folder`, which only the job's own steps share. */
  async save(folder: string): Promise<void> {
    await mkdir(join(folder, BODIES), { recursive: true, mode: 0o700 });
    const index: ReadsIndex = { version: VERSION, token: this.#token, answers: [] };
    const queues = new Map([...this.#answers].map(([key, answers]) => [key, [...answers]]));
    for (const key of this.#order) {
      const answer = queues.get(key)?.shift();
      if (answer === undefined) continue;
      const body = answer.body.hash;
      await writeFile(join(folder, BODIES, body), contentBytes(answer.body), { mode: 0o600 });
      index.answers.push({ key, status: answer.status, type: answer.type, body });
    }
    await writeFile(join(folder, INDEX), JSON.stringify(index), { mode: 0o600 });
  }

  close(): void { this.#spool.close(); this.#answers.clear(); this.#order = []; }

  #add(key: string, answer: {status: number; type: string; body: SpooledFile}): void {
    const queue = this.#answers.get(key);
    if (queue === undefined) this.#answers.set(key, [answer]);
    else queue.push(answer);
    this.#order.push(key);
  }
}

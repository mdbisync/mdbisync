// Linear's answers to one run's reads, kept so that a later step of the same
// job can use them instead of reading Linear again. The staged security
// steps read Linear once per run this way: the stage step keeps the answers
// to its capture's reads (GraphQL queries and upload downloads), and the
// apply step's capture takes them, each once, in the order it asks; a read
// the stage step did not make goes to Linear. When the apply step's capture
// ends, the rest of its run reads Linear itself, so the checks before a
// write never see an old answer.
//
// The record holds answers only: never a request's headers, a token or an
// upload's signed address (reads are keyed by a hash of the request).

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { type AuthContext, authMetadata } from './diagnostics.ts';

const VERSION = 1;

/** One kept answer: its status, its content type and its bytes. */
export interface KeptAnswer {
  status: number;
  type: string;
  body: Buffer;
}

interface ReadsFile {
  version: number;
  /** The scopes and metadata of the stage step's token, for the apply step's setup check. */
  token: { scope: string[]; context: AuthContext } | null;
  answers: Array<{ key: string; status: number; type: string; body: string }>;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The key of a GraphQL request: its whole body (query, variables, operation name). */
export const graphqlReadKey = (body: string) => sha256(`graphql\n${body}`);
/** The key of an upload download: its address, which may carry a signature, never stored as such. */
export const uploadReadKey = (url: string) => sha256(`upload\n${url}`);

export class LinearReads {
  readonly mode: 'record' | 'replay';
  #answers: Array<{ key: string } & KeptAnswer>;
  #token: ReadsFile['token'];
  #ended = false;

  private constructor(mode: 'record' | 'replay', file: ReadsFile | null) {
    this.mode = mode;
    this.#token = file?.token ?? null;
    this.#answers = (file?.answers ?? []).map(({ key, status, type, body }) => ({ key, status, type, body: Buffer.from(body, 'base64') }));
  }

  /** The stage step: keeps every answer it is given. */
  static recording(): LinearReads {
    return new LinearReads('record', null);
  }

  /** The apply step: the stage step's record, or null when it left none (that step did not run, or ran another version). */
  static async replaying(file: string): Promise<LinearReads | null> {
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) return null;
    const read = JSON.parse(text) as ReadsFile;
    if (read.version !== VERSION || read.token === null) return null;
    return new LinearReads('replay', read);
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
    const at = this.#answers.findIndex((answer) => answer.key === key);
    if (at < 0) return undefined;
    const [answer] = this.#answers.splice(at, 1);
    return answer;
  }

  /** Keeps a successful answer while recording. */
  keep(key: string, answer: KeptAnswer): void {
    if (this.mode !== 'record' || this.#ended || answer.status < 200 || answer.status >= 300) return;
    this.#answers.push({ key, ...answer });
  }

  /** The capture ended: nothing more is kept or answered. */
  end(): void {
    this.#ended = true;
  }

  async save(file: string): Promise<void> {
    const out: ReadsFile = {
      version: VERSION,
      token: this.#token,
      answers: this.#answers.map(({ key, status, type, body }) => ({ key, status, type, body: body.toString('base64') })),
    };
    await writeFile(file, JSON.stringify(out), { mode: 0o600 });
  }
}

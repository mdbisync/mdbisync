// The heads the sync records as its own pushes, signed.
//
// The sync's state lives in refs that anyone who may push to the repository
// can rewrite. A record that a head is the sync's own push lets the checks
// expected of a later head stop at it, so the record carries a signature
// keyed by the sync's own secret: a record the sync did not write proves
// nothing, and the history below the head is read as unknown.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { type Oid } from './git.ts';

/** A head the sync's state records as its own push on a branch, with its signature; one recorded before signatures has none. */
export interface PushedRecord {
  head: Oid;
  mac?: string;
}

/** The parts of a pull repair its signature covers: all of them. */
export interface SignedRepair {
  source?: string;
  hash: string;
  observedHash: string;
  replacement: string;
  images: ReadonlyArray<{ image: number; total: number; line: number }>;
}

/** A signature's form in the state. */
export const PUSHED_MAC = /^[0-9a-f]{64}$/;

const KEY_LABEL = 'mdbisync pushed head v1';

/**
 * Signs and checks the records of the sync's own pushes. The key is derived
 * from a secret only the sync holds, and a signature binds the repository
 * and the branch, so a record cannot move to another branch or repository.
 * A new secret makes the older records unknown: the sync's next push records
 * its head again.
 */
export class PushedKey {
  readonly #key: Buffer;
  readonly #repository: string;

  constructor(secret: string, repository: string) {
    this.#key = createHmac('sha256', secret).update(KEY_LABEL).digest();
    // GitHub compares repository names without case.
    this.#repository = repository.toLowerCase();
  }

  /** The signed record of `head` as the sync's own push on `ref`. */
  record(ref: string, head: Oid): Required<PushedRecord> {
    return { head, mac: this.#mac(ref, head) };
  }

  /** The head `record` names, when the sync signed it for `ref`; none for a record without a valid signature. */
  verified(ref: string, record: PushedRecord | undefined): Oid | undefined {
    if (record?.mac === undefined || !PUSHED_MAC.test(record.mac)) return undefined;
    const expected = Buffer.from(this.#mac(ref, record.head), 'hex');
    return timingSafeEqual(expected, Buffer.from(record.mac, 'hex')) ? record.head : undefined;
  }

  /** Bind the uploaded bytes and their URL to this repository. */
  uploadMac(hash: string, url: string): string {
    return createHmac('sha256', this.#key).update(JSON.stringify(['upload-v1', this.#repository, hash, url])).digest('hex');
  }

  verifiesUpload(hash: string, url: string, mac: unknown): boolean {
    if (typeof mac !== 'string' || !PUSHED_MAC.test(mac)) return false;
    return timingSafeEqual(Buffer.from(this.uploadMac(hash, url), 'hex'), Buffer.from(mac, 'hex'));
  }

  /**
   * The signature of a `linear` state commit the sync writes: its tree, its
   * parents and its message, bound to this repository (see `observation.ts`).
   */
  observationMac(tree: Oid, parents: readonly Oid[], text: string): string {
    return createHmac('sha256', this.#key).update(JSON.stringify(['linear-v1', this.#repository, tree, parents, text])).digest('hex');
  }

  verifiesObservation(tree: Oid, parents: readonly Oid[], text: string, mac: string): boolean {
    if (!PUSHED_MAC.test(mac)) return false;
    return timingSafeEqual(Buffer.from(this.observationMac(tree, parents, text), 'hex'), Buffer.from(mac, 'hex'));
  }

  /**
   * The signature of a pull repair the sync recorded: the document's path and
   * id, the observation commit it came from, the observed bytes it applies to
   * and the text it puts there, bound to this repository (see `pull-repairs.ts`).
   */
  repairMac(path: string, id: string, repair: SignedRepair): string {
    const images = repair.images.map(({image, total, line}) => [image, total, line]);
    return createHmac('sha256', this.#key).update(JSON.stringify(['repair-v1', this.#repository, path, id, repair.source ?? null, repair.hash, repair.observedHash, repair.replacement, images])).digest('hex');
  }

  verifiesRepair(path: string, id: string, repair: SignedRepair & { mac?: unknown }): boolean {
    if (typeof repair.mac !== 'string' || !PUSHED_MAC.test(repair.mac)) return false;
    return timingSafeEqual(Buffer.from(this.repairMac(path, id, repair), 'hex'), Buffer.from(repair.mac, 'hex'));
  }

  /**
   * The signature of an unfinished initial sync's write receipt: the path,
   * the document's id, the hash of the text sent and the digest of what
   * Linear returned, bound to this repository. A resumed run trusts a
   * document on that digest alone only with a valid one (see `confirm.ts`).
   */
  writtenMac(path: string, id: string, hash: string, observedDigest: string): string {
    return createHmac('sha256', this.#key).update(JSON.stringify(['written-v1', this.#repository, path, id, hash, observedDigest])).digest('hex');
  }

  verifiesWritten(path: string, id: string, hash: string, observedDigest: string, mac: unknown): boolean {
    if (typeof mac !== 'string' || !PUSHED_MAC.test(mac)) return false;
    return timingSafeEqual(Buffer.from(this.writtenMac(path, id, hash, observedDigest), 'hex'), Buffer.from(mac, 'hex'));
  }

  #mac(ref: string, head: Oid): string {
    return createHmac('sha256', this.#key).update(`${this.#repository}\n${ref}\n${head}`).digest('hex');
  }
}

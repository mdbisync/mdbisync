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

  #mac(ref: string, head: Oid): string {
    return createHmac('sha256', this.#key).update(`${this.#repository}\n${ref}\n${head}`).digest('hex');
  }
}

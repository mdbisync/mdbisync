// Seeded, deterministic pseudo-random numbers for the corpus generator.
// The same seed always yields the same sequence on every platform, so the
// generated tree is byte-identical between runs.

import { createHash } from "node:crypto";

export class Rng {
  #a: number;
  #b: number;
  #c: number;
  #d: number;
  readonly seed: string;

  constructor(seed: string) {
    this.seed = seed;
    // Derive the 128-bit state from the seed text, so short or similar seeds
    // still start far apart.
    const digest = createHash("sha256").update(seed).digest();
    this.#a = digest.readUInt32LE(0);
    this.#b = digest.readUInt32LE(4);
    this.#c = digest.readUInt32LE(8);
    this.#d = digest.readUInt32LE(12) | 1;
    for (let i = 0; i < 16; i++) this.uint32();
  }

  /** sfc32: a small, fast generator with a long period. */
  uint32(): number {
    const t = (((this.#a + this.#b) | 0) + this.#d) | 0;
    this.#d = (this.#d + 1) | 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) | 0;
    this.#c = (this.#c << 21) | (this.#c >>> 11);
    this.#c = (this.#c + t) | 0;
    return t >>> 0;
  }

  /** A float in [0, 1). */
  next(): number {
    return this.uint32() / 0x1_0000_0000;
  }

  /** An integer in [min, max], both ends included. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from an empty list");
    return items[this.int(0, items.length - 1)] as T;
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  /** A new array in random order; the input is left as it was. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  bytes(length: number): Buffer {
    const out = Buffer.alloc(length);
    let i = 0;
    for (; i + 4 <= length; i += 4) out.writeUInt32LE(this.uint32(), i);
    if (i < length) {
      const last = this.uint32();
      for (let k = 0; i < length; i++, k++) out[i] = (last >>> (8 * k)) & 0xff;
    }
    return out;
  }

  hex(length: number): string {
    return this.bytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
  }

  /**
   * A child generator whose sequence depends only on this generator's seed
   * and the label, not on how much of this sequence was used, so adding a
   * group does not change the files of the others.
   */
  fork(label: string): Rng {
    return new Rng(`${this.seed}/${label}`);
  }
}

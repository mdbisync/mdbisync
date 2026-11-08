import { test } from "node:test";
import assert from "node:assert/strict";
import { Rng } from "./rng.ts";

test("the same seed gives the same sequence", () => {
  const a = new Rng("corpus-1");
  const b = new Rng("corpus-1");
  for (let i = 0; i < 1000; i++) assert.equal(a.uint32(), b.uint32());
});

test("different seeds give different sequences", () => {
  assert.notEqual(new Rng("corpus-1").hex(32), new Rng("corpus-2").hex(32));
});

test("a fork depends only on the seed and its label", () => {
  const used = new Rng("corpus-1");
  used.bytes(4096);
  assert.equal(used.fork("images").hex(32), new Rng("corpus-1").fork("images").hex(32));
  assert.notEqual(used.fork("images").hex(32), used.fork("tables").hex(32));
});

test("int stays within its bounds and reaches both ends", () => {
  const rng = new Rng("bounds");
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i++) {
    const n = rng.int(3, 7);
    assert.ok(n >= 3 && n <= 7);
    seen.add(n);
  }
  assert.deepEqual([...seen].sort(), [3, 4, 5, 6, 7]);
});

test("bytes returns exactly the length asked for", () => {
  const rng = new Rng("bytes");
  for (const length of [0, 1, 3, 4, 5, 1023]) assert.equal(rng.bytes(length).length, length);
});

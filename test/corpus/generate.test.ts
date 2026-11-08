import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCorpus } from "./check.ts";
import { longTitle } from "./documents.ts";
import { buildCorpus, writeCorpus } from "./generate.ts";
import { MINI_DOCUMENTS } from "./slices.ts";
import { COLLISIONS } from "./tree.ts";

// The default corpus, built once for the tests that only read it.
let defaultCorpus: ReturnType<typeof buildCorpus> | undefined;
function corpus(): ReturnType<typeof buildCorpus> {
  defaultCorpus ??= buildCorpus();
  return defaultCorpus;
}

function treeDigest(dir: string, base = dir): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) for (const [k, v] of treeDigest(full, base)) out.set(k, v);
    else out.set(full.slice(base.length + 1), createHash("sha256").update(readFileSync(full)).digest("hex"));
  }
  return out;
}

test("the same seed writes byte-identical trees, and the result passes the corpus check", () => {
  const a = mkdtempSync(join(tmpdir(), "corpus-a-"));
  const b = mkdtempSync(join(tmpdir(), "corpus-b-"));
  try {
    writeCorpus(buildCorpus("determinism"), a, false);
    writeCorpus(buildCorpus("determinism"), b, false);
    const left = treeDigest(a);
    const right = treeDigest(b);
    assert.ok(left.size >= 2000, `only ${left.size} files`);
    assert.deepEqual([...left.keys()].sort(), [...right.keys()].sort());
    for (const [path, digest] of left) assert.equal(right.get(path), digest, path);

    const result = checkCorpus(a);
    assert.deepEqual(result.problems, []);
    assert.ok(result.files >= 2000);
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("a different seed changes the generated content but not the layout rules", () => {
  const one = buildCorpus("seed-one");
  const two = buildCorpus("seed-two");
  const text = (c: ReturnType<typeof buildCorpus>) => c.files.filter((f) => f.group === "work-documents").map((f) => f.content.toString()).join("");
  assert.notEqual(text(one), text(two));
  assert.equal(one.files.filter((f) => f.group === "pairwise").length, two.files.filter((f) => f.group === "pairwise").length);
});

test("long titles have exactly the asked length and fit the file name limit", () => {
  for (const length of [100, 200, 250, 255, 256, 300]) {
    const title = longTitle(length);
    assert.equal(title.length, length);
    for (const segment of title.split("/")) assert.ok(Buffer.byteLength(`${segment}.md`) <= 255, segment);
  }
});

test("the slices are closed and the mini slice has its twelve documents", () => {
  const built = corpus();
  const byPath = new Map(built.files.map((f) => [f.path, f]));
  for (const [slice, paths] of Object.entries(built.slices)) {
    for (const path of paths) {
      const file = byPath.get(path);
      assert.ok(file, `${slice}: ${path}`);
      for (const target of file.links) assert.ok(paths.includes(target), `${slice}: ${path} links to ${target}, which the slice leaves out`);
    }
    assert.ok(paths.includes(".gitattributes") && paths.includes(".pre-commit-config.yaml"), slice);
  }
  const documents = built.slices.mini.filter((p) => byPath.get(p)?.synced && byPath.get(p)?.kind === "markdown");
  assert.equal(documents.length, MINI_DOCUMENTS);
  assert.equal(built.slices.full.length, built.files.length);
});

test("one image is used by exactly 40 documents, and two files are over the upload limit", () => {
  const users = corpus().files.filter((f) => f.links.includes("docs/handbook/assets/shared-logo.png"));
  assert.equal(users.length, 40);
  const tooLarge = corpus().files.filter((f) => f.kind !== "markdown" && f.rule === "upload-too-large").map((f) => f.kind);
  assert.deepEqual(tooLarge.sort(), ["attachment", "image"]);
});

test("duplicate-title fixtures are taken from the bank once, never paired by the generator", () => {
  const built = corpus();
  const generated = built.files.filter((f) => f.path.startsWith(`${COLLISIONS}/`) && f.group !== "construct-singles");
  assert.deepEqual(generated, []);
  for (const excluded of built.manifest.excluded) {
    assert.ok(!built.files.some((f) => f.path.endsWith(excluded.file)), excluded.file);
  }
});

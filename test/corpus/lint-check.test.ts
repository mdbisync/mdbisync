import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLintExpectations } from "./check.ts";
import { buildCorpus, writeCorpus, type Manifest } from "./generate.ts";

let root = "";
let manifest: Manifest;

before(() => {
  root = mkdtempSync(join(tmpdir(), "corpus-lint-"));
  writeCorpus(buildCorpus(), root, false);
  manifest = JSON.parse(readFileSync(join(root, "corpus-slices/manifest.json"), "utf8")) as Manifest;
});

after(() => rmSync(root, { recursive: true, force: true }));

function withClass(path: string, expected: string | null, run: () => void): void {
  const file = join(root, "corpus-slices/manifest.json");
  const original = readFileSync(file);
  try {
    const changed = JSON.parse(original.toString()) as Manifest;
    changed.files.find((f) => f.path === path)!.class = expected;
    writeFileSync(file, JSON.stringify(changed));
    run();
  } finally {
    writeFileSync(file, original);
  }
}

test("the default full corpus has exactly the lint-error paths declared by its manifest", () => {
  assert.deepEqual(checkLintExpectations(root), []);
  const collisions = manifest.files.filter((f) => f.synced && f.rule === "duplicate-title");
  assert.ok(collisions.length >= 4, "the full corpus exercises duplicate-title findings too");
});

test("a lint error removed from the manifest is reported once with its rule", () => {
  const file = manifest.files.find((f) => f.synced && f.rule === "footnote")!;
  withClass(file.path, "fixable", () => {
    assert.deepEqual(checkLintExpectations(root), [`unexpected lint-error: ${file.path} (footnote)`]);
  });
});

test("a manifest lint error that the linter accepts is reported", () => {
  const file = manifest.files.find((f) => f.synced && f.group === "work-documents" && f.rule === null)!;
  withClass(file.path, "lint-error", () => {
    assert.deepEqual(checkLintExpectations(root), [`missing lint-error: ${file.path}`]);
    const command = spawnSync(process.execPath, ["test/corpus/check.ts", root, "--lint"], { encoding: "utf8" });
    assert.equal(command.status, 1, command.stderr);
    assert.ok(command.stderr.includes(`missing lint-error: ${file.path}`));
  });
});

test("the cross-check reports each colliding path even when its content has no error", () => {
  const file = manifest.files.find((f) => f.synced && f.rule === "duplicate-title")!;
  withClass(file.path, null, () => {
    assert.deepEqual(checkLintExpectations(root), [`unexpected lint-error: ${file.path} (duplicate-title)`]);
  });
});

test("the lint cross-check is available through the corpus check command", () => {
  assert.match(execFileSync(process.execPath, ["test/corpus/check.ts", root, "--lint"], { encoding: "utf8" }), /corpus ok:/);
});

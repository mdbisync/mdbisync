import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCorpus, checkLintExpectations } from "./check.ts";
import { buildCorpus, writeCorpus, type Manifest } from "./generate.ts";

const checker = fileURLToPath(new URL("./check.ts", import.meta.url));

// One generated tree; each test breaks one thing, checks, and restores it.
let root = "";
let manifest: Manifest;

before(() => {
  root = mkdtempSync(join(tmpdir(), "corpus-check-"));
  writeCorpus(buildCorpus("a".repeat(40)), root, false);
  manifest = JSON.parse(readFileSync(join(root, "corpus-slices", "manifest.json"), "utf8")) as Manifest;
});

after(() => rmSync(root, { recursive: true, force: true }));

function withChange(path: string, change: (original: Buffer) => Buffer | null, run: () => void): void {
  const full = join(root, path);
  const original = readFileSync(full);
  try {
    const next = change(original);
    if (next === null) rmSync(full);
    else writeFileSync(full, next);
    run();
  } finally {
    writeFileSync(full, original);
  }
}

function problems(options: { git?: boolean } = {}): string[] {
  return checkCorpus(root, options).problems;
}

const firstDocument = () => manifest.files.find((f) => f.path.endsWith(".md") && f.canary_in === "content" && f.group === "work-documents")!;

test("the untouched tree passes", () => {
  assert.deepEqual(problems(), []);
});

test("a Markdown file without its canary is reported", () => {
  const entry = firstDocument();
  withChange(`corpus/${entry.path}`, (b) => Buffer.from(b.toString().replace(entry.canary as string, "kx-removed")), () => {
    assert.ok(problems().some((p) => p.includes(`canary ${entry.canary} not found`) && p.includes(entry.path)));
  });
});

test("a Cyrillic character is reported with its file and line", () => {
  const entry = firstDocument();
  withChange(`corpus/${entry.path}`, (b) => Buffer.concat([b, Buffer.from(`\n${String.fromCodePoint(0x436)}\n`)]), () => {
    assert.ok(problems().some((p) => p.startsWith(`Cyrillic character: ${entry.path}:`)));
  });
});

test("a file missing from the tree and a file missing from the manifest are both reported", () => {
  const entry = firstDocument();
  withChange(`corpus/${entry.path}`, () => null, () => {
    assert.ok(problems().some((p) => p === `missing from the tree: ${entry.path}`));
  });
  const extra = join(root, "corpus", "stray.md");
  writeFileSync(extra, "stray");
  try {
    assert.ok(problems().includes("not in the manifest: stray.md"));
  } finally {
    rmSync(extra);
  }
});

test("a group below its minimum is reported", () => {
  const path = "corpus-slices/manifest.json";
  withChange(path, (b) => {
    const m = JSON.parse(b.toString()) as Manifest;
    for (const f of m.files) if (f.group === "mermaid") f.group = "pairwise";
    return Buffer.from(JSON.stringify(m));
  }, () => {
    assert.ok(problems().some((p) => p.startsWith("group mermaid has 0 files")));
  });
});

test("an LFS flag that disagrees with the attributes is reported", () => {
  const path = "corpus-slices/manifest.json";
  const image = manifest.files.find((f) => f.kind === "image" && f.lfs)!;
  withChange(path, (b) => {
    const m = JSON.parse(b.toString()) as Manifest;
    m.files.find((f) => f.path === image.path)!.lfs = false;
    return Buffer.from(JSON.stringify(m));
  }, () => {
    assert.ok(problems().includes(`LFS flag does not match the attributes: ${image.path}`));
  });
});

test("a .gitattributes that routes files differently is reported", () => {
  withChange("corpus/.gitattributes", (b) => Buffer.from(b.toString().replace("*.png ", "*.zzz ").replace("*.PNG ", "*.ZZZ ")), () => {
    assert.ok(problems().includes(".gitattributes differs from the corpus LFS rules"));
  });
});

test("in a git checkout, an LFS file must be a pointer", () => {
  const image = manifest.files.find((f) => f.kind === "image" && f.lfs)!;
  // The generated tree holds real content, so every LFS file is reported.
  const found = problems({ git: true });
  assert.ok(found.includes(`expected an LFS pointer: ${image.path}`));
  // A pointer with the right size satisfies the check.
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"0".repeat(64)}\nsize ${image.bytes}\n`;
  withChange(`corpus/${image.path}`, () => Buffer.from(pointer), () => {
    assert.ok(!problems({ git: true }).includes(`expected an LFS pointer: ${image.path}`));
  });
});

test("a size that differs from the manifest is reported", () => {
  const entry = firstDocument();
  withChange(`corpus/${entry.path}`, (b) => Buffer.concat([b, Buffer.from(" ")]), () => {
    assert.ok(problems().some((p) => p.includes("differs from the manifest") && p.endsWith(entry.path)));
  });
});

test("the two size cases carry their roles, and a missing or doubled role is reported", () => {
  const pdf = manifest.files.find((f) => f.role === "pdf-11mb");
  const image = manifest.files.find((f) => f.role === "image-over-10mb");
  assert.ok(pdf && pdf.path.endsWith(".pdf") && pdf.bytes > 11 * 1000 * 1000, "the PDF over 11 MB has its role");
  assert.ok(image && image.kind === "image" && image.bytes > 10 * 1024 * 1024, "the image over 10 MB has its role");
  const withRoles = (change: (m: Manifest) => void) => (b: Buffer) => {
    const m = JSON.parse(b.toString()) as Manifest;
    change(m);
    return Buffer.from(JSON.stringify(m));
  };
  withChange("corpus-slices/manifest.json", withRoles((m) => {
    for (const f of m.files) if (f.role === "pdf-11mb") f.role = null;
  }), () => {
    assert.ok(problems().includes("role pdf-11mb is on 0 files"));
  });
  withChange("corpus-slices/manifest.json", withRoles((m) => {
    (m.files.find((f) => f.path.endsWith(".md")) as Manifest["files"][number]).role = "image-over-10mb";
  }), () => {
    assert.ok(problems().some((p) => p.startsWith("role image-over-10mb is on 2 files")));
  });
});

function withClass(path: string, expected: string | null, run: () => void): void {
  withChange("corpus-slices/manifest.json", (original) => {
    const changed = JSON.parse(original.toString()) as Manifest;
    changed.files.find((f) => f.path === path)!.class = expected;
    return Buffer.from(JSON.stringify(changed));
  }, run);
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
    const command = spawnSync(process.execPath, [checker, root, "--lint"], { encoding: "utf8" });
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
  assert.match(execFileSync(process.execPath, [checker, root, "--lint"], { encoding: "utf8", cwd: tmpdir() }), /corpus ok:/);
});

test("a missing lint-error document is reported once under --lint", () => {
  const file = manifest.files.find((f) => f.synced && f.rule === "footnote")!;
  withChange(`corpus/${file.path}`, () => null, () => {
    assert.deepEqual(checkCorpus(root, { lint: true }).problems, [`missing from the tree: ${file.path}`]);
  });
});

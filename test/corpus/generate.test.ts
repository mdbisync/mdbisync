import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fitScene, gifFrames, PLAN } from "./assets.ts";
import { linkTargets, rewrite, targetPath } from "./bank.ts";
import { checkCorpus } from "./check.ts";
import { longTitle } from "./documents.ts";
import { buildCorpus, writeCorpus } from "./generate.ts";
import { parse } from "yaml";
import { CONTENT_LIMIT, gitattributes, SHARED_IMAGE_USERS } from "./model.ts";
import { Rng } from "./rng.ts";
import { MINI_DOCUMENTS } from "./slices.ts";
import { fixText, lintText } from "../../src/format/index.ts";
import { COLLISIONS, EDGE, LOOSE, preCommitConfig } from "./tree.ts";

// The default corpus, built once for the tests that only read it.
let defaultCorpus: ReturnType<typeof buildCorpus> | undefined;
function corpus(): ReturnType<typeof buildCorpus> {
  defaultCorpus ??= buildCorpus("a".repeat(40));
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
    writeCorpus(buildCorpus("a".repeat(40), "determinism"), a, false);
    writeCorpus(buildCorpus("a".repeat(40), "determinism"), b, false);
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
  const one = corpus();
  const two = buildCorpus("a".repeat(40), "seed-two");
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
  for (const slice of ["mini", "mid"] as const) {
    assert.deepEqual(built.slices[slice].filter((p) => byPath.get(p)?.macosUnsafe), [], `${slice} holds a macOS-unsafe name`);
  }
  assert.equal(built.slices.full.length, built.files.length);
});

test("one image is used by exactly 40 documents, and two files are over the upload limit", () => {
  const users = corpus().files.filter((f) => f.links.includes("docs/handbook/assets/shared-logo.png"));
  assert.equal(users.length, 40);
  const tooLarge = corpus().files.filter((f) => f.kind !== "markdown" && f.rule === "upload-too-large").map((f) => f.kind);
  assert.deepEqual(tooLarge.sort(), ["attachment", "image"]);
});

test("the mid slice holds the shared image and every document that embeds it", () => {
  const built = corpus();
  const mid = new Set(built.slices.mid);
  const image = built.files.find((f) => f.role === "shared-image");
  assert.ok(image && mid.has(image.path));
  const users = built.files.filter((f) => f.synced && f.kind === "markdown" && f.links.includes(image.path));
  assert.equal(users.length, SHARED_IMAGE_USERS);
  assert.deepEqual(users.filter((f) => !mid.has(f.path)).map((f) => f.path), []);
});

test("duplicate-title fixtures are taken from the bank once, never paired by the generator", () => {
  const built = corpus();
  const generated = built.files.filter((f) => f.path.startsWith(`${COLLISIONS}/`) && f.group !== "construct-singles");
  assert.deepEqual(generated, []);
  for (const excluded of built.manifest.excluded) {
    assert.ok(!built.files.some((f) => f.path.endsWith(excluded.file)), excluded.file);
  }
});

test("reference definitions count as links; footnote definitions do not", () => {
  const found = linkTargets("![Banner][banner]\n\n[banner]: ../assets/banner.png\n\nText[^1]\n\n[^1]: a note\n\n[site]: https://www.example.com\n");
  assert.deepEqual(found, [{ written: "../assets/banner.png", form: "definition" }]);
});

test("every relative link a corpus document writes is in its dependency list", () => {
  const built = corpus();
  const byPath = new Map(built.files.map((f) => [f.path, f]));
  const reference = byPath.get("docs/reference/images/reference.md");
  assert.ok(reference, "the bank's reference-style image fixture is in the corpus");
  assert.ok(reference.links.includes("docs/reference/assets/banner.png"), "a reference-style image records its image");
  for (const file of built.files) {
    if (file.kind !== "markdown") continue;
    for (const { written } of linkTargets(file.content.toString("utf8"))) {
      const bare = (written.startsWith("<") ? written.slice(1, -1) : written).split("#")[0] as string;
      const target = posix.normalize(posix.join(posix.dirname(file.path), decodeURI(bare)));
      if (byPath.has(target)) assert.ok(file.links.includes(target), `${file.path} links to ${target} without listing it`);
    }
  }
});

test("HTML src and href count as links, and the HTML image fixture records its image", () => {
  assert.deepEqual(linkTargets('<img src="../assets/banner.png" alt="x">\n<a href="https://www.example.com">y</a>\n'), [{ written: "../assets/banner.png", form: "html" }]);
  const html = corpus().files.find((f) => f.path === "docs/reference/html-extensions/html-img.md");
  assert.ok(html?.links.includes("docs/reference/assets/banner.png"));
});

test("bank fixtures whose links still reach their files are copied unchanged, then in Linear's form", () => {
  for (const name of ["links/spaces-angle.md", "links/spaces-encoded.md", "links/relative.md", "images/reference.md"]) {
    const copied = corpus().files.find((f) => f.path === `docs/reference/${name}`);
    assert.ok(copied, name);
    assert.equal(copied.content.toString("utf8"), fixText(readFileSync(join("test/fixtures", name), "utf8")), name);
  }
});

test("every synced document outside the lint-error set is already in Linear's form", () => {
  const files = corpus().files.filter((f) => f.synced && f.kind === "markdown");
  for (const file of files) {
    const text = file.content.toString("utf8");
    if (file.expected === "lint-error") continue;
    assert.equal(fixText(text), text, `${file.path} is not in Linear's form`);
    assert.notEqual(file.expected, "fixable", `${file.path} is still classed fixable`);
  }
  // The lint-error files are written as generated: fix never touches them.
  assert.ok(files.some((f) => f.expected === "lint-error"));
});

test("the size cases at Linear's limit keep their exact length in Linear's form", () => {
  const files = corpus().files.filter((f) => f.group === "size-spectrum" && f.expected !== "lint-error");
  for (const [name, length] of [["at-limit", CONTENT_LIMIT], ["at-limit-minus-one", CONTENT_LIMIT - 1], ["size-240kb-1", 240_000], ["size-1kb-1", 1_000]] as const) {
    const file = files.find((f) => f.path.endsWith(`/${name}.md`));
    assert.ok(file, name);
    assert.equal([...file.content.toString("utf8")].length, length, name);
  }
});

test("a file rewritten into Linear's form says so, and fix never changes a fixture Linear keeps as it is", () => {
  const index = parse(readFileSync("test/fixtures/index.yaml", "utf8")) as { fixtures: { file: string; class?: string; basis?: string }[] };
  const keptByLinear = new Set(index.fixtures.filter((f) => f.class === "unchanged" && f.basis === "known").map((f) => `docs/reference/${f.file}`));
  for (const file of corpus().files) {
    if (!file.note?.includes("Linear's form")) continue;
    assert.ok(!keptByLinear.has(file.path), `${file.path}: Linear keeps the fixture as it is, but fix changes it`);
  }
  const rewritten = corpus().files.filter((f) => f.note?.includes("written in Linear's form"));
  assert.ok(rewritten.length > 0);
});

test("a malformed percent escape is kept as written, and replacements are literal", () => {
  assert.equal(targetPath("100%.md"), "100%.md");
  assert.equal(targetPath("<a%20b.md#part>"), "a b.md");
  const text = "[a](old.md) and\n\n[ref]: old.md\n";
  assert.equal(rewrite(text, { written: "old.md", form: "inline" }, "new $& name.md"), "[a](<new $& name.md>) and\n\n[ref]: old.md\n");
  assert.equal(rewrite(text, { written: "old.md", form: "definition" }, "$1.md"), "[a](old.md) and\n\n[ref]: $1.md\n");
});

test("bank files above every annotation are unsynced, and every bank fixture keeps its bank group", () => {
  const built = corpus();
  for (const file of built.files.filter((f) => f.path.startsWith(`${LOOSE}/`))) {
    assert.equal(file.synced, false, file.path);
    assert.equal(file.group, "unsynced", file.path);
  }
  const bankFiles = built.manifest.files.filter((f) => f.path.startsWith("docs/reference/") && f.path !== "docs/reference/README.md");
  assert.ok(bankFiles.length > 200);
  for (const file of bankFiles) assert.ok(file.bank_group, file.path);
});

test("every document in a slice has the annotation READMEs above it", () => {
  const built = corpus();
  const byPath = new Map(built.files.map((f) => [f.path, f]));
  for (const [slice, paths] of Object.entries(built.slices)) {
    const inSlice = new Set(paths);
    for (const path of paths) {
      const file = byPath.get(path);
      if (!file?.synced) continue;
      for (let dir = posix.dirname(path); dir !== "."; dir = posix.dirname(dir)) {
        const readme = byPath.get(`${dir}/README.md`);
        if (readme?.group === "annotations") assert.ok(inSlice.has(readme.path), `${slice}: ${path} without ${readme.path}`);
      }
    }
  }
});

test("every generated image and attachment has its own content", () => {
  // Uploads are deduplicated by content hash, so two equal files would test one upload.
  const seen = new Map<string, string>();
  for (const file of corpus().files) {
    if ((file.kind !== "image" && file.kind !== "attachment") || file.bankGroup !== null || file.path.startsWith(`${LOOSE}/`)) continue;
    const digest = createHash("sha256").update(file.content).digest("hex");
    assert.equal(seen.get(digest), undefined, `${file.path} has the same content as ${seen.get(digest)}`);
    seen.set(digest, file.path);
  }
});

test("the corpus attributes keep CRLF documents byte-exact even with core.autocrlf", () => {
  const repo = mkdtempSync(join(tmpdir(), "corpus-eol-"));
  try {
    const run = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    run("init", "-q");
    run("config", "core.autocrlf", "true");
    writeFileSync(join(repo, ".gitattributes"), gitattributes());
    const crlf = "# Title\r\n\r\nLine one\r\nLine two\r\n";
    writeFileSync(join(repo, "doc.md"), crlf);
    run("add", ".gitattributes", "doc.md");
    assert.equal(run("cat-file", "-p", ":doc.md"), crlf);
    assert.match(run("check-attr", "text", "doc.md"), /text: unset/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("generated alignment, image titles and marker contexts follow the fixture bank", () => {
  const built = corpus();
  const cases = [
    { matches: /\/tables\/aligned-/, fixture: "tables/table-alignment.md", count: 14 },
    { matches: /edge-cases\/images\/titled-image\.md$/, fixture: "images/title.md", count: 1 },
    ...[
      "conflict-markers/in-code-fence.md",
      "conflict-markers/in-quote.md",
      "conflict-markers/in-inline-code.md",
      "conflict-markers/diff3-in-fence.md",
      "conflict-markers/in-indented-code.md",
    ].map((fixture, i) => ({ matches: new RegExp(`merges/marker-lookalike-(${i + 1}|${i + 6})\\.md$`), fixture, count: 2 })),
  ];
  for (const { matches, fixture, count } of cases) {
    const reference = built.manifest.files.find((f) => f.path === `docs/reference/${fixture}`);
    assert.ok(reference, fixture);
    const generated = built.manifest.files.filter((f) => matches.test(f.path));
    assert.equal(generated.length, count, fixture);
    for (const file of generated) {
      assert.deepEqual(
        // The basis can differ: a bank copy may match the form the probe recorded, a generated file was never probed.
        [file.class, file.rule],
        [reference.class, reference.rule],
        file.path,
      );
    }
  }
});

test("generated quoted markers stay separate paragraphs and diff3 examples include the base", () => {
  const built = corpus();
  for (const n of [2, 7]) {
    const quote = built.files.find((f) => f.path.endsWith(`/marker-lookalike-${n}.md`));
    assert.ok(quote);
    assert.match(quote.content.toString(), /> <<<<<<< ours\n>\n> the old line\n>\n> =======\n>\n> the new line\n>\n> >>>>>>> theirs/);
  }
  for (const n of [4, 9]) {
    const diff3 = built.files.find((f) => f.path.endsWith(`/marker-lookalike-${n}.md`));
    assert.ok(diff3);
    assert.match(diff3.content.toString(), /```text\n<<<<<<< ours\nthe old line\n\|{7} base\nthe base line\n=======\nthe new line\n>>>>>>> theirs\n```/);
  }
});

test("every animated GIF scene and size moves from frame to frame", () => {
  const gif = PLAN.find((p) => p.format === "gif");
  assert.ok(gif);
  for (const scene of [...gif.scenes, "screenshot" as const]) {
    for (const [width, height] of gif.sizes) {
      const frames = gifFrames(new Rng(`${scene}-${width}`), width, height, { scene: fitScene(scene, width, height), title: "TITLE", labels: ["ONE", "TWO", "THREE", "FOUR"], accent: [37, 99, 235] }, true);
      assert.ok(frames.length > 1);
      for (let f = 1; f < frames.length; f++) {
        assert.notDeepEqual(frames[f]?.indices, frames[f - 1]?.indices, `${scene} ${width}x${height}: frame ${f + 1} repeats frame ${f}`);
      }
    }
  }
});

test("the linter flags exactly the documents the manifest classes as lint errors", () => {
  // Duplicate titles are a property of a pair of paths, not of one file's text.
  for (const file of corpus().files) {
    if (file.kind !== "markdown" || !file.synced || file.rule === "duplicate-title") continue;
    const rules: string[] = [...new Set(lintText(file.path, new TextDecoder().decode(file.content)).map((f) => f.rule))];
    if (file.expected === "lint-error") assert.ok(rules.includes(file.rule as string), `${file.path}: expected ${file.rule}, the linter found [${rules.join(", ")}]`);
    else assert.deepEqual(rules, [], `${file.path} is not classed as a lint error`);
  }
});

test("edge cases stay in the edge-case area and the Markdown reference, away from the everyday documents", () => {
  const edgeGroups = new Set(["pairwise", "size-spectrum", "conflict-markers", "lint-errors"]);
  for (const file of corpus().files) {
    if (file.kind !== "markdown" || [`${EDGE}/`, "docs/reference/", `${LOOSE}/`].some((p) => file.path.startsWith(p))) continue;
    assert.ok(!edgeGroups.has(file.group), `${file.path} (${file.group}) belongs in ${EDGE}`);
    assert.notEqual(file.expected, "lint-error", `${file.path} is a lint error outside ${EDGE}`);
  }
});

test("the corpus configuration requires and retains a full release commit pin", () => {
  const revision = "1234567890abcdef1234567890abcdef12345678";
  assert.match(preCommitConfig(revision), new RegExp(`rev: ${revision}`));
  assert.match(preCommitConfig(revision), /id: linear-format/);
  assert.match(preCommitConfig(revision), /alias: security/);
  for (const invalid of ["", "main", "v0.1.0-rc.1", "HOOK_REV_PLACEHOLDER", "a".repeat(40) + "\n"]) {
    assert.throws(() => preCommitConfig(invalid), /full lowercase commit SHA/);
  }
  const generated = corpus().files.find((file) => file.path === ".pre-commit-config.yaml")!;
  assert.match(generated.content.toString(), /rev: a{40}\n/);
});

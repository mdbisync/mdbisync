import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { test } from "node:test";
import { fixText, lintText, splitFile } from "../../src/format/index.ts";
import { buildDemo, DATA, type DemoFile } from "./generate.ts";
import { drawPicture, type PictureData } from "./pictures.ts";

const files: DemoFile[] = buildDemo();
const documents = files.filter((f) => f.path.endsWith(".md"));
const byPath = new Set(files.map((f) => f.path));

test("every document is in Linear's form: lint finds nothing and fix changes nothing", () => {
  for (const doc of documents) {
    const text = doc.bytes.toString("utf8");
    assert.deepEqual(lintText(doc.path, text), [], doc.path);
    assert.equal(fixText(text), text, doc.path);
  }
});

test("every relative link and image points to a file of the corpus", () => {
  for (const doc of documents) {
    const text = doc.bytes.toString("utf8");
    for (const match of text.matchAll(/\]\(<?([^)>]+)>?\)/g)) {
      const target = decodeURIComponent(match[1]!);
      if (/^[a-z]+:/.test(target)) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(doc.path), target.split("#")[0]!));
      assert.ok(byPath.has(resolved), `${doc.path}: ${target}`);
    }
  }
});

test("no Linear container comes near the document cap", () => {
  // Folders with a README.md are the team and project folders; a document belongs to the nearest one.
  const homes = documents.filter((d) => posix.basename(d.path) === "README.md").map((d) => posix.dirname(d.path));
  const counts = new Map<string, number>();
  for (const doc of documents) {
    const home = homes.filter((h) => doc.path.startsWith(`${h}/`)).sort((a, b) => b.length - a.length)[0];
    assert.ok(home, `${doc.path} is outside every annotated folder`);
    counts.set(home, (counts.get(home) ?? 0) + 1);
  }
  for (const [home, count] of counts) assert.ok(count <= 100, `${home}: ${count} documents`);
});

test("the texts carry no personal data and say nothing about how they are used", () => {
  const people = /\bDemo[A-Z][a-z]+\b/g;
  const allowed = new Set(["DemoAlice", "DemoBob", "DemoCarol", "DemoDave", "DemoErin", "DemoFrank", "DemoGrace", "DemoHeidi", "DemoIvan", "DemoJudy", "DemoKen", "DemoLaura", "DemoMike", "DemoNina", "DemoOscar", "DemoPeggy", "DemoCompany", "DemoMart"]);
  for (const doc of documents) {
    // The folder annotations in front matter never leave the repository; the body is what readers see.
    const text = splitFile(doc.bytes.toString("utf8")).body;
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.]+/, `${doc.path}: an email address`);
    assert.doesNotMatch(text, /\bmdbisync\b|\blinear\b/i, `${doc.path}: names the tool or Linear`);
    for (const name of text.match(people) ?? []) assert.ok(allowed.has(name), `${doc.path}: unknown placeholder ${name}`);
  }
});

test("pictures are drawn the same way every time", () => {
  for (const name of readdirSync(DATA).sort().slice(0, 4)) {
    const data = JSON.parse(readFileSync(join(DATA, name), "utf8")) as PictureData;
    assert.ok(drawPicture(data).equals(drawPicture(data)), name);
  }
});

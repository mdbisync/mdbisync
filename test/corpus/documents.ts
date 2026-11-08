// The generated Markdown groups of the corpus.

import { posix } from "node:path";
import type { AssetRef, Assets } from "./assets.ts";
import { CONTENT_LIMIT, destination, markdownFile, relativeLink, type Canaries, type CorpusFile, type Group } from "./model.ts";
import type { Rng } from "./rng.ts";
import {
  asciiFiller, capitalize, EMOJI, EMOJI_SEQUENCES, isoDate, paragraph, person, SCRIPT_SAMPLES, sentence, slug, team, title, word,
} from "./text.ts";
import { HOMES, LOOSE, type Home } from "./tree.ts";

type Context = {
  rng: Rng;
  canaries: Canaries;
  assets: Assets;
  files: CorpusFile[];
  /** Paths already taken, so generated names never collide. */
  taken: Set<string>;
};

type DocOptions = {
  links?: string[];
  expected?: CorpusFile["expected"];
  rule?: string | null;
  basis?: CorpusFile["basis"];
  note?: string | null;
  canaryIn?: "content" | "name";
  /** The canary to use when the body already holds one. */
  canary?: string;
};

let homeCursor = 0;

function nextHome(): Home {
  return HOMES[homeCursor++ % HOMES.length] as Home;
}

function uniquePath(ctx: Context, folder: string, name: string, ext = "md"): string {
  let path = `${folder}/${name}.${ext}`;
  for (let i = 2; ctx.taken.has(path); i++) path = `${folder}/${name}-${i}.${ext}`;
  ctx.taken.add(path);
  return path;
}

function addDoc(ctx: Context, path: string, body: string | Buffer, group: Group, options: DocOptions = {}): CorpusFile {
  const file = markdownFile({
    path,
    content: typeof body === "string" ? Buffer.from(body, "utf8") : body,
    group,
    canary: options.canary ?? null,
    canaryIn: options.canaryIn ?? "content",
    expected: options.expected ?? null,
    rule: options.rule ?? null,
    basis: options.basis ?? null,
    note: options.note ?? null,
    links: options.links ?? [],
  });
  ctx.files.push(file);
  return file;
}

/** Writes a document whose body ends with its canary line. */
function doc(ctx: Context, folder: string, name: string, group: Group, build: (canary: string) => string, options: DocOptions = {}): CorpusFile {
  const canary = ctx.canaries.take();
  return addDoc(ctx, uniquePath(ctx, folder, name), build(canary), group, { ...options, canary });
}

function imageMarkdown(from: string, ref: AssetRef, titleText?: string): string {
  const target = destination(relativeLink(from, ref.path));
  return titleText === undefined ? `![${ref.label}](${target})` : `![${ref.label}](${target} "${titleText}")`;
}

function linkMarkdown(from: string, ref: AssetRef): string {
  return `[${ref.label}](${destination(relativeLink(from, ref.path))})`;
}

function takeAsset(ctx: Context, home: Home, kind: AssetRef["kind"]): AssetRef | undefined {
  const queue = ctx.assets.queues.get(home.path) ?? [];
  const i = queue.findIndex((a) => a.kind === kind);
  return i < 0 ? undefined : queue.splice(i, 1)[0];
}

// ---------------------------------------------------------------- work documents

const TEMPLATES = ["meeting-notes", "spec", "runbook", "decision-record", "onboarding-guide", "changelog", "faq"] as const;
const TEMPLATE_FOLDERS: Record<(typeof TEMPLATES)[number], string> = {
  "meeting-notes": "meetings",
  spec: "specs",
  runbook: "runbooks",
  "decision-record": "decisions",
  "onboarding-guide": "onboarding",
  changelog: "changelogs",
  faq: "faq",
};

function workBody(ctx: Context, template: (typeof TEMPLATES)[number], heading: string, extra: string[]): string {
  const { rng } = ctx;
  const lines: string[] = [`# ${heading}`, ""];
  switch (template) {
    case "meeting-notes":
      lines.push(`Date: ${isoDate(rng)}`, "", `Attendees: ${person(rng)}, ${person(rng)}, ${person(rng)}`, "", "## Agenda", "");
      for (let i = 0; i < rng.int(2, 5); i++) lines.push(`1. ${sentence(rng)}`);
      lines.push("", "## Notes", "", paragraph(rng), "", "## Action items", "");
      for (let i = 0; i < rng.int(2, 4); i++) lines.push(`* [${rng.bool() ? "x" : " "}] ${person(rng)}: ${sentence(rng)}`);
      break;
    case "spec":
      lines.push("## Summary", "", paragraph(rng), "", "## Goals", "");
      for (let i = 0; i < 3; i++) lines.push(`* ${sentence(rng)}`);
      lines.push("", "## Design", "", paragraph(rng), "", "```json", JSON.stringify({ [word(rng)]: rng.int(1, 100), enabled: rng.bool() }, null, 2), "```", "", "## Risks", "", paragraph(rng));
      break;
    case "runbook":
      lines.push("## When to use", "", paragraph(rng), "", "## Steps", "");
      for (let i = 0; i < rng.int(3, 7); i++) lines.push(`${i + 1}. ${sentence(rng)}`);
      lines.push("", "```sh", `check-${word(rng)} --region ${rng.pick(["north", "south", "east", "west"])}`, "```", "", "> **Warning:** " + sentence(rng));
      break;
    case "decision-record":
      lines.push("## Status", "", rng.pick(["Proposed", "Accepted", "Superseded"]), "", "## Context", "", paragraph(rng), "", "## Decision", "", paragraph(rng), "", "## Consequences", "", paragraph(rng));
      break;
    case "onboarding-guide":
      lines.push(`Welcome to the ${team(rng)} team.`, "", "## First week", "");
      for (let i = 0; i < 4; i++) lines.push(`* **Day ${i + 1}:** ${sentence(rng)}`);
      lines.push("", "## Useful links", "", `* [Team page](https://www.example.com/${slug(team(rng))})`, `* [Handbook](https://www.example.com/handbook)`);
      break;
    case "changelog":
      for (let v = 0; v < rng.int(2, 5); v++) {
        lines.push(`## 1.${rng.int(0, 20)}.${rng.int(0, 9)} (${isoDate(rng)})`, "");
        for (let i = 0; i < rng.int(1, 4); i++) lines.push(`* ${rng.pick(["Added", "Fixed", "Changed", "Removed"])}: ${sentence(rng)}`);
        lines.push("");
      }
      break;
    case "faq":
      for (let i = 0; i < rng.int(3, 6); i++) lines.push(`### ${capitalize(word(rng))}: how does it work?`, "", paragraph(rng), "");
      break;
  }
  lines.push("", ...extra);
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}`;
}

function workDocuments(ctx: Context, sharedUsers: number): void {
  const { rng } = ctx;
  let shared = 0;
  const count = 800;
  for (let i = 0; i < count; i++) {
    const home = nextHome();
    const template = TEMPLATES[i % TEMPLATES.length] as (typeof TEMPLATES)[number];
    const heading = title(rng);
    const folder = `${home.path}/${template === "runbook" && i % 9 === 0 ? "runbooks/2026/q4/storage" : TEMPLATE_FOLDERS[template]}`;
    const path = uniquePath(ctx, folder, `${slug(heading)}`);
    const extra: string[] = [];
    const links: string[] = [];
    let tooLarge: string | null = null;
    for (const kind of ["image", "image", "attachment"] as const) {
      if (kind === "attachment" && !rng.bool(0.25)) continue;
      const ref = takeAsset(ctx, home, kind);
      if (!ref) continue;
      extra.push(kind === "image" ? imageMarkdown(path, ref) : `Attached: ${linkMarkdown(path, ref)}`, "");
      links.push(ref.path);
      if (ref.tooLarge) tooLarge = ref.path;
    }
    if (shared < sharedUsers && i % 20 === 3) {
      extra.push(imageMarkdown(path, ctx.assets.shared), "");
      links.push(ctx.assets.shared.path);
      shared++;
    }
    const canary = ctx.canaries.take();
    extra.push(`Reference: ${canary}`);
    addDoc(ctx, path, workBody(ctx, template, heading, extra), "work-documents", {
      canary,
      links,
      ...(tooLarge === null ? {} : { rule: "upload-too-large", note: `embeds or links ${tooLarge}, over the upload limit` }),
    });
  }
  // Documents for whatever is left in the queues: every asset is used at least once.
  for (const home of HOMES) {
    const queue = ctx.assets.queues.get(home.path) ?? [];
    while (queue.length > 0) {
      const batch = queue.splice(0, 6);
      const path = uniquePath(ctx, `${home.path}/galleries`, `screenshots-${slug(word(rng))}`);
      const canary = ctx.canaries.take();
      const body = [`# Screenshots for the ${word(rng)} review`, "", paragraph(rng), "", ...batch.flatMap((ref) => [ref.kind === "image" ? imageMarkdown(path, ref) : linkMarkdown(path, ref), ""]), `Reference: ${canary}`].join("\n");
      const tooLarge = batch.find((r) => r.tooLarge);
      addDoc(ctx, path, body, "work-documents", {
        canary,
        links: batch.map((r) => r.path),
        ...(tooLarge === undefined ? {} : { rule: "upload-too-large", note: `embeds or links ${tooLarge.path}, over the upload limit` }),
      });
    }
  }
  // The shared image needs 40 documents in all.
  while (shared < sharedUsers) {
    const home = nextHome();
    doc(ctx, `${home.path}/announcements`, `announcement-${shared + 1}`, "work-documents", (canary) => {
      const path = `${home.path}/announcements/announcement-${shared + 1}.md`;
      return `# Announcement\n\n${imageMarkdown(path, ctx.assets.shared)}\n\n${paragraph(rng)}\n\nReference: ${canary}`;
    }, { links: [ctx.assets.shared.path] });
    shared++;
  }
}

/** A title path of exactly the given length, in segments of at most 120 characters. */
export function longTitle(length: number): string {
  const prefix = `long-titles/t${length}`;
  let rest = length - prefix.length;
  const segments = [prefix];
  while (rest > 0) {
    const take = Math.min(120, rest - 1); // one character goes to the "/"
    if (take <= 0) {
      // A single character left: lengthen the last segment instead of adding "/".
      segments[segments.length - 1] += "x";
      rest -= 1;
      continue;
    }
    segments.push("x".repeat(take));
    rest -= take + 1;
  }
  return segments.join("/");
}

/** Special work documents: long titles, deep paths, names in other scripts, image edge cases. */
function specialDocuments(ctx: Context): void {
  const { rng } = ctx;
  // Titles are paths below the team folder, without ".md". A file name is
  // at most 255 bytes, so long titles are split across folders.
  for (const length of [100, 200, 250, 255, 256, 300]) {
    const titlePath = longTitle(length);
    const folder = `eng/${posix.dirname(titlePath)}`;
    doc(ctx, folder, posix.basename(titlePath), "work-documents", (canary) => `# Long title\n\n${paragraph(rng)}\n\nReference: ${canary}`, {
      note: `title "${titlePath}" is ${length} characters`,
    });
  }
  // Six folders deep.
  doc(ctx, "eng/infra/regions/north/storage/archive", "retention-policy", "work-documents", (canary) => `# Retention policy\n\n${paragraph(rng)}\n\nReference: ${canary}`, { note: "six folders deep" });
  // Names with spaces, dots, parentheses, Greek, CJK and emoji.
  for (const name of ["meeting notes (draft)", "v2.1 release.plan", "Σημειώσεις συνάντησης", "会议记录", "🚀 launch checklist", "notes  with  double spaces"]) {
    doc(ctx, "eng/backend/names", name, "work-documents", (canary) => `# ${name}\n\n${paragraph(rng)}\n\nReference: ${canary}`);
  }
  // Image edge cases.
  const path = (folder: string, name: string) => `${folder}/${name}.md`;
  doc(ctx, "docs/handbook/images", "broken-image", "work-documents", (canary) => `# Missing picture\n\n![diagram that is not there](./missing/diagram.png)\n\nReference: ${canary}`, { note: "a broken image reference" });
  doc(ctx, "docs/handbook/images", "remote-image", "work-documents", (canary) => `# Remote picture\n\n![remote chart](https://images.example.com/chart.png)\n\nReference: ${canary}`, { note: "a remote image URL" });
  const titled = ctx.assets.shared;
  doc(ctx, "docs/handbook/images", "titled-image", "work-documents", (canary) => `# Picture with a title\n\n${imageMarkdown(path("docs/handbook/images", "titled-image"), titled, "Team logo, light version")}\n\nReference: ${canary}`, {
    links: [titled.path],
    note: "an image with a title",
  });
}

// ---------------------------------------------------------------- pairwise

const INLINE: [string, (rng: Rng) => string][] = [
  ["code", (rng) => `\`${word(rng)}()\``],
  ["bold", (rng) => `**${word(rng)}**`],
  ["italic", (rng) => `*${word(rng)}*`],
  ["strike", (rng) => `~~${word(rng)}~~`],
  ["link", (rng) => `[${word(rng)}](https://www.example.com/${word(rng)})`],
  ["math", () => "$a^2 + b^2$"],
  ["emoji", (rng) => rng.pick(EMOJI)],
  ["underline", (rng) => `<u>${word(rng)}</u>`],
  ["highlight", (rng) => `==${word(rng)}==`],
  ["bold-italic", (rng) => `***${word(rng)}***`],
];

const OUTER = ["bullet", "ordered", "quote", "heading", "task", "table-cell", "nested-list", "alert"] as const;

function wrap(outer: (typeof OUTER)[number], inner: string, rng: Rng): string {
  switch (outer) {
    case "bullet":
      return `* ${sentence(rng)} ${inner}\n* ${sentence(rng)}`;
    case "ordered":
      return `1. ${inner} ${sentence(rng)}\n2. ${sentence(rng)}`;
    case "quote":
      return `> ${sentence(rng)} ${inner}\n> ${sentence(rng)}`;
    case "heading":
      return `## ${capitalize(word(rng))} ${inner}`;
    case "task":
      return `* [ ] ${inner} ${sentence(rng)}\n* [x] ${sentence(rng)}`;
    case "table-cell":
      return `| Item | Detail |\n| -- | -- |\n| ${word(rng)} | ${inner} |\n| ${word(rng)} | ${sentence(rng)} |`;
    case "nested-list":
      return `* ${sentence(rng)}\n  * ${inner}\n    * ${sentence(rng)}`;
    case "alert":
      return `> [!NOTE]\n> ${inner} ${sentence(rng)}`;
  }
}

const BLOCKS: [string, (rng: Rng) => string][] = [
  ["code-in-list", (rng) => `* ${sentence(rng)}\n\n  \`\`\`sh\n  run-${word(rng)} --check\n  \`\`\``],
  ["list-in-quote", (rng) => `> ${sentence(rng)}\n>\n> * ${word(rng)}\n> * ${word(rng)}`],
  ["code-in-quote", (rng) => `> \`\`\`text\n> ${sentence(rng)}\n> \`\`\``],
  ["quote-in-list", (rng) => `* ${sentence(rng)}\n\n  > ${sentence(rng)}`],
  ["task-with-link", (rng) => `* [ ] Read [the ${word(rng)} notes](https://www.example.com/${word(rng)})`],
];

function pairwise(ctx: Context): void {
  const { rng } = ctx;
  let n = 0;
  const combos: [string, (rng: Rng) => string][] = [];
  for (const outer of OUTER) for (const [name, inner] of INLINE) combos.push([`${outer}-${name}`, (r) => wrap(outer, inner(r), r)]);
  combos.push(...BLOCKS);
  while (n < 300) {
    const [name, make] = combos[n % combos.length] as [string, (rng: Rng) => string];
    const home = nextHome();
    const imageRef = n % 15 === 0 ? ctx.assets.secondary : undefined;
    const folder = `${home.path}/pairwise`;
    const path = uniquePath(ctx, folder, `${name}-${Math.floor(n / combos.length) + 1}`);
    const canary = ctx.canaries.take();
    const parts = [`# ${capitalize(name.replace(/-/g, " "))}`, "", make(rng), ""];
    if (imageRef) parts.push(`* ${sentence(rng)} ${imageMarkdown(path, imageRef)}`, "", `| Preview |\n| -- |\n| ${imageMarkdown(path, imageRef)} |`, "");
    parts.push(`Reference: ${canary}`);
    addDoc(ctx, path, parts.join("\n"), "pairwise", { canary, links: imageRef ? [imageRef.path] : [] });
    n++;
  }
}

// ---------------------------------------------------------------- size spectrum

function sizeSpectrum(ctx: Context): void {
  const { rng } = ctx;
  const folder = "eng/infra/sizes";
  const named = (name: string, content: string, note: string) => {
    const canary = ctx.canaries.take();
    addDoc(ctx, uniquePath(ctx, folder, `${name}-${canary}`), content, "size-spectrum", { canary, canaryIn: "name", note });
  };
  named("empty", "", "empty file");
  named("empty-2", "", "empty file");
  named("whitespace-only", "   \n\n\t\n", "whitespace only");
  named("whitespace-only-2", "\n", "a single newline");
  named("whitespace-only-3", " ", "a single space");
  const sized = (name: string, length: number, note: string, options: DocOptions = {}) => {
    const canary = ctx.canaries.take();
    const head = `# ${capitalize(name)}\n\nReference: ${canary}\n\n`;
    addDoc(ctx, uniquePath(ctx, folder, name), head + asciiFiller(rng, length - head.length), "size-spectrum", { canary, note, ...options });
  };
  for (let i = 0; i < 5; i++) {
    const canary = ctx.canaries.take();
    addDoc(ctx, uniquePath(ctx, folder, `one-line-${i + 1}`), `${sentence(rng)} Reference: ${canary}${i % 2 === 0 ? "\n" : ""}`, "size-spectrum", { canary, note: "one line" });
  }
  const ladder: [string, number, number][] = [["size-1kb", 1_000, 8], ["size-10kb", 10_000, 8], ["size-100kb", 100_000, 5], ["size-240kb", 240_000, 4]];
  for (const [name, length, count] of ladder) for (let i = 0; i < count; i++) sized(`${name}-${i + 1}`, length, `${length} characters`);
  sized("at-limit-minus-one", CONTENT_LIMIT - 1, `${CONTENT_LIMIT - 1} characters, just under Linear's limit`);
  sized("at-limit", CONTENT_LIMIT, `${CONTENT_LIMIT} characters, exactly Linear's limit`);
  sized("size-260kb", 260_000, "260,000 characters, over Linear's limit", { expected: "lint-error", rule: "content-too-long", basis: "known" });
  for (let i = 0; i < 3; i++) {
    const canary = ctx.canaries.take();
    const line = `Reference: ${canary} ${asciiFiller(rng, 100_000).replace(/\s+/g, " ")}`.slice(0, 100_000);
    addDoc(ctx, uniquePath(ctx, folder, `single-line-100k-${i + 1}`), line, "size-spectrum", { canary, note: "one line of 100,000 characters" });
  }
  // Fill the group to at least 50 with mid sizes.
  let k = 1;
  while (ctx.files.filter((f) => f.group === "size-spectrum").length < 50) sized(`size-5kb-${k++}`, 5_000, "5,000 characters");
}

// ---------------------------------------------------------------- mermaid

const DIAGRAMS: Record<string, (rng: Rng) => string> = {
  flowchart: (rng) => `flowchart LR\n    A[${capitalize(word(rng))}] --> B{Ready?}\n    B -->|yes| C[Ship]\n    B -->|no| D[Fix]`,
  sequence: (rng) => `sequenceDiagram\n    participant ${person(rng)}\n    participant Service\n    Service->>Service: ${word(rng)}\n    Note right of Service: ${sentence(rng)}`,
  class: (rng) => `classDiagram\n    class ${capitalize(word(rng))} {\n      +String name\n      +run()\n    }`,
  state: () => "stateDiagram-v2\n    [*] --> Draft\n    Draft --> Review\n    Review --> Done\n    Done --> [*]",
  er: () => "erDiagram\n    TEAM ||--o{ PROJECT : owns\n    PROJECT ||--|{ DOCUMENT : contains",
  gantt: (rng) => `gantt\n    title ${title(rng)}\n    dateFormat YYYY-MM-DD\n    section Work\n    Design :a1, 2026-01-05, 10d\n    Build  :after a1, 20d`,
  pie: (rng) => `pie title ${capitalize(word(rng))} split\n    "Done" : ${rng.int(10, 60)}\n    "Open" : ${rng.int(10, 60)}`,
  journey: (rng) => `journey\n    title ${title(rng)}\n    section Start\n      Read the guide: 5: ${person(rng)}\n      Ask a question: 3: ${person(rng)}`,
  gitGraph: () => "gitGraph\n    commit\n    branch feature\n    commit\n    checkout main\n    merge feature",
  mindmap: (rng) => `mindmap\n  root((${capitalize(word(rng))}))\n    Goals\n    Risks\n    People`,
  timeline: () => "timeline\n    title Release history\n    2025 : First release\n    2026 : Second release",
  quadrant: () => "quadrantChart\n    title Effort and value\n    x-axis Low effort --> High effort\n    y-axis Low value --> High value\n    Task A: [0.3, 0.6]",
};

function mermaid(ctx: Context): void {
  const { rng } = ctx;
  const kinds = Object.keys(DIAGRAMS);
  for (let i = 0; i < 60; i++) {
    const home = nextHome();
    const count = 1 + (i % 4);
    const chosen = Array.from({ length: count }, (_, k) => kinds[(i + k * 5) % kinds.length] as string);
    const invalid = i % 20 === 7;
    doc(ctx, `${home.path}/diagrams`, `diagrams-${chosen[0]}-${i + 1}`, "mermaid", (canary) => {
      const parts = [`# ${title(rng)}`, "", paragraph(rng), ""];
      for (const kind of chosen) parts.push("```mermaid", (DIAGRAMS[kind] as (r: Rng) => string)(rng), "```", "");
      if (invalid) parts.push("```mermaid", "flowchart LR\n    A --> \n    this is not a diagram ((", "```", "");
      parts.push(`Reference: ${canary}`);
      return parts.join("\n");
    }, { note: invalid ? `${chosen.join(", ")}, and an invalid diagram` : chosen.join(", ") });
  }
}

// ---------------------------------------------------------------- tables

function table(rows: string[][], align?: string[]): string {
  const header = rows[0] as string[];
  const sep = align ?? header.map(() => "--");
  return [header, sep, ...rows.slice(1)].map((r) => `| ${r.join(" | ")} |`).join("\n");
}

function tables(ctx: Context): void {
  const { rng } = ctx;
  const kinds = ["aligned", "wide", "long", "empty-cells", "inline-marks", "code-pipes", "links-images", "unicode", "plain"] as const;
  for (let i = 0; i < 120; i++) {
    const home = nextHome();
    const kind = kinds[i % kinds.length] as (typeof kinds)[number];
    const folder = `${home.path}/tables`;
    const path = uniquePath(ctx, folder, `${kind}-${i + 1}`);
    const canary = ctx.canaries.take();
    const links: string[] = [];
    let body: string;
    switch (kind) {
      case "aligned":
        body = table([["Left", "Center", "Right"], ...Array.from({ length: 4 }, () => [word(rng), word(rng), String(rng.int(1, 999))])], [":--", ":-:", "--:"]);
        break;
      case "wide":
        body = table(Array.from({ length: 4 }, (_, r) => Array.from({ length: 30 }, (_, c) => (r === 0 ? `C${c + 1}` : String(rng.int(0, 99))))));
        break;
      case "long":
        body = table([["#", "Item", "Owner"], ...Array.from({ length: i % 18 === 2 ? 500 : 60 }, (_, r) => [String(r + 1), word(rng), person(rng)])]);
        break;
      case "empty-cells":
        body = table([["A", "B", "C"], ["", word(rng), ""], [word(rng), "", ""], ["", "", ""]]);
        break;
      case "inline-marks":
        body = table([["Mark", "Example"], ["bold", `**${word(rng)}**`], ["italic", `*${word(rng)}*`], ["strike", `~~${word(rng)}~~`], ["code", `\`${word(rng)}\``]]);
        break;
      case "code-pipes":
        body = table([["Expression", "Meaning"], ["`a \\| b`", "either"], ["`x \\|\\| y`", "logical or"]]);
        break;
      case "links-images": {
        const ref = ctx.assets.secondary;
        links.push(ref.path);
        body = table([["Link", "Image"], [`[docs](https://www.example.com/${word(rng)})`, imageMarkdown(path, ref)]]);
        break;
      }
      case "unicode":
        body = table([["Script", "Text"], ...Object.entries(SCRIPT_SAMPLES).map(([k, v]) => [k, v[0] as string]), ["emoji", EMOJI_SEQUENCES.slice(0, 3).join(" ")]]);
        break;
      case "plain":
        body = table([["Name", "Value"], [word(rng), String(rng.int(1, 100))]]);
        break;
    }
    addDoc(ctx, path, `# ${capitalize(kind.replace(/-/g, " "))} table\n\n${body}\n\nReference: ${canary}`, "tables", { canary, links, note: kind === "long" ? "long table" : null });
  }
  doc(ctx, "eng/backend/tables", "escaped-pipe-plain-cell", "tables", (canary) => `# Escaped pipe\n\n${table([["Choice", "Value"], ["either", "a \\| b"]])}\n\nReference: ${canary}`, {
    expected: "lint-error",
    rule: "table-escaped-pipe",
    basis: "known",
    note: "an escaped pipe in a plain cell splits the row",
  });
}

// ---------------------------------------------------------------- typography and scripts

function typography(ctx: Context): void {
  const { rng } = ctx;
  const features: [string, (rng: Rng) => string][] = [
    ["marks", (r) => `**bold** *italic* ~~strike~~ \`code\` <u>underline</u> ==highlight== ^sup^ ***both*** **bold with *italic* inside** ${word(r)}`],
    ...Object.entries(SCRIPT_SAMPLES).map(([name, lines]): [string, (rng: Rng) => string] => [name, () => lines.join("\n\n")]),
    ["emoji", () => `${EMOJI.join(" ")}\n\n${EMOJI_SEQUENCES.join(" ")}`],
    ["combining", () => "Cafe\u0301, nai\u0308ve, a\u0323\u0302, Z\u0335\u0321a\u0337l\u0336g\u0338o"],
    ["math-alphanumerics", () => "𝐁𝐨𝐥𝐝 𝐼𝑡𝑎𝑙𝑖𝑐 𝔉𝔯𝔞𝔨𝔱𝔲𝔯 𝕯𝖔𝖚𝖇𝖑𝖊 𝟘𝟙𝟚"],
    ["spaces", () => "non\u00a0breaking, narrow\u202fno-break, zero\u200bwidth, joiner\u200d, thin\u2009space"],
    ["quotes", () => "\u201cSmart quotes\u201d, \u2018single\u2019, \u00abguillemets\u00bb, \u201elow\u201c, em\u2014dash, en\u2013dash, ellipsis\u2026"],
    ["tabs", (r) => `Column\tValue\n${word(r)}\t${r.int(1, 99)}\n\tindented with a tab`],
    ["bidi", () => `Mixed: English, ${SCRIPT_SAMPLES.arabic?.[0]} and ${SCRIPT_SAMPLES.hebrew?.[0]} in one line.`],
  ];
  for (let i = 0; i < 120; i++) {
    const home = nextHome();
    const [name, make] = features[i % features.length] as [string, (rng: Rng) => string];
    const ending = i % 10 === 4 ? "crlf" : i % 10 === 7 ? "bom" : "lf";
    const canary = ctx.canaries.take();
    let text = `# ${capitalize(name)} ${i + 1}\n\n${make(rng)}\n\n${paragraph(rng)}\n\nReference: ${canary}\n`;
    if (ending === "crlf") text = text.replace(/\n/g, "\r\n");
    const content = ending === "bom" ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]) : Buffer.from(text);
    addDoc(ctx, uniquePath(ctx, `${home.path}/typography`, `${name}-${i + 1}`), content, "typography-scripts", {
      canary,
      note: ending === "lf" ? null : ending === "crlf" ? "CRLF line endings" : "starts with a byte order mark",
    });
  }
}

// ---------------------------------------------------------------- links

function linksGroup(ctx: Context): void {
  const { rng } = ctx;
  const folder = "eng/frontend/link-targets";
  // Targets first, so links can point at them; they count in the group too.
  const targets: CorpusFile[] = [];
  for (const name of ["overview", "setup guide", "faq (draft)", "notes.v1", "glossary"]) {
    targets.push(doc(ctx, folder, name, "links", (canary) => `# ${capitalize(name)}\n\n## Details\n\n${paragraph(rng)}\n\nReference: ${canary}`));
  }
  const unsynced = `${LOOSE}/data/inventory.csv`;
  for (let i = 0; i < 75; i++) {
    const home = nextHome();
    const path = uniquePath(ctx, `${home.path}/links`, `links-${i + 1}`);
    const target = targets[i % targets.length] as CorpusFile;
    const rel = relativeLink(path, target.path);
    const forms = [
      `See [the ${posix.basename(target.path, ".md")}](${destination(rel)}).`,
      `Jump to [details](${destination(`${rel}#details`)}).`,
      `Raw data lives in [the inventory](${destination(relativeLink(path, unsynced))}), which is not synchronized.`,
      `Visit [the site](https://www.example.com/${word(rng)}) or <https://www.example.org/${word(rng)}>.`,
      `Read [the guide][guide] later.\n\n[guide]: https://www.example.com/guide`,
      `Write to [the team](mailto:team@example.com).`,
      `A link with [parentheses](https://www.example.com/page_(draft)) and [spaces](<https://www.example.com/a page>).`,
    ];
    const chosen = [forms[i % forms.length] as string, forms[(i + 3) % forms.length] as string];
    const canary = ctx.canaries.take();
    const links = chosen.some((f) => f.includes(rel)) ? [target.path] : [];
    if (chosen.some((f) => f.includes("inventory"))) links.push(unsynced);
    addDoc(ctx, path, `# Links ${i + 1}\n\n${chosen.join("\n\n")}\n\nReference: ${canary}`, "links", { canary, links });
  }
}

// ---------------------------------------------------------------- front matter

function frontMatter(ctx: Context): void {
  const { rng } = ctx;
  for (let i = 0; i < 60; i++) {
    const home = nextHome();
    const canary = ctx.canaries.take();
    const only = i % 10 === 9;
    const yaml = [
      `title: "${title(rng)}"`,
      `owner: ${person(rng)}`,
      `date: ${isoDate(rng)}`,
      `tags: [${word(rng)}, ${word(rng)}]`,
      "reviewers:",
      `  - ${person(rng)}`,
      `  - ${person(rng)}`,
      "meta:",
      `  team: ${team(rng)}`,
      "  limits:",
      `    daily: ${rng.int(1, 100)}`,
      "summary: |",
      `  ${sentence(rng)}`,
      `  ${sentence(rng)}`,
      `note: "${SCRIPT_SAMPLES.greek?.[0]} ${rng.pick(EMOJI)}"`,
      `reference: ${canary}`,
    ];
    const body = only ? `---\n${yaml.join("\n")}\n---\n` : `---\n${yaml.join("\n")}\n---\n\n# ${title(rng)}\n\n${paragraph(rng)}\n`;
    addDoc(ctx, uniquePath(ctx, `${home.path}/front-matter`, `${only ? "front-matter-only" : "with-front-matter"}-${i + 1}`), body, "front-matter", {
      canary,
      note: only ? "front matter only" : null,
    });
  }
}

// ---------------------------------------------------------------- HTML and extensions

function htmlExtensions(ctx: Context): void {
  const { rng } = ctx;
  const forms: [string, (rng: Rng) => string][] = [
    ["html-block", (r) => `<div align="center">\n  <strong>${word(r)}</strong>\n</div>`],
    ["comment", (r) => `<!-- ${sentence(r)} -->\n\n${sentence(r)}`],
    ["details", (r) => `<details>\n<summary>${capitalize(word(r))}</summary>\n\n${paragraph(r)}\n\n</details>`],
    ["definition-list", (r) => `${capitalize(word(r))}\n: ${sentence(r)}`],
    ["alert-note", (r) => `> [!NOTE]\n> ${sentence(r)}`],
    ["alert-warning", (r) => `> [!WARNING]\n> ${sentence(r)}`],
    ["inline-math", () => "The ratio is $\\frac{a}{b}$ and $x_1 + x_2$."],
    ["block-math", () => "$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$"],
    ["emoji-shortcode", () => "Good work :smile: :rocket: :tada:"],
    ["task-list", (r) => `* [ ] ${sentence(r)}\n* [x] ${sentence(r)}`],
  ];
  for (let i = 0; i < 100; i++) {
    const home = nextHome();
    const [name, make] = forms[i % forms.length] as [string, (rng: Rng) => string];
    doc(ctx, `${home.path}/extensions`, `${name}-${i + 1}`, "html-extensions", (canary) => `# ${capitalize(name.replace(/-/g, " "))}\n\n${make(rng)}\n\nReference: ${canary}`);
  }
}

// ---------------------------------------------------------------- conflict-marker lookalikes

function conflictMarkers(ctx: Context): void {
  const { rng } = ctx;
  const markers = "<<<<<<< ours\nthe old line\n=======\nthe new line\n>>>>>>> theirs";
  const forms = [
    (s: string) => `\`\`\`text\n${s}\n\`\`\``,
    (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n"),
    () => "Inline: `<<<<<<< ours` and `=======` and `>>>>>>> theirs`.",
    (s: string) => `\`\`\`diff\n${s}\n\`\`\``,
    (s: string) => `    ${s.split("\n").join("\n    ")}`,
  ];
  for (let i = 0; i < 10; i++) {
    const form = forms[i % forms.length] as (s: string) => string;
    doc(ctx, "eng/backend/merges", `marker-lookalike-${i + 1}`, "conflict-markers", (canary) => `# How merges look\n\n${paragraph(rng)}\n\n${form(markers)}\n\nReference: ${canary}`, {
      note: "conflict-marker lines that are not a conflict",
    });
  }
}

// ---------------------------------------------------------------- lint errors

function lintErrors(ctx: Context): void {
  const { rng } = ctx;
  const folder = "docs/handbook/needs-fixing";
  const make = (rule: string, name: string, body: (canary: string) => string) =>
    // Every rule here is one ADR-003 lists as observed in Linear.
    doc(ctx, folder, name, "lint-errors", body, { expected: "lint-error", rule, basis: "known" });
  for (let i = 0; i < 8; i++) make("footnote", `footnote-${i + 1}`, (c) => `# Sources\n\n${sentence(rng)}[^${i + 1}]\n\n[^${i + 1}]: ${sentence(rng)}\n\nReference: ${c}`);
  for (let i = 0; i < 7; i++) make("subscript", `subscript-${i + 1}`, (c) => `# Formula\n\nWater is H~2~O and ${word(rng)}~${i + 1}~ follows.\n\nReference: ${c}`);
  for (let i = 0; i < 6; i++) make("table-escaped-pipe", `escaped-pipe-${i + 1}`, (c) => `# Options\n\n${table([["Option", "Values"], [word(rng), "a \\| b"]])}\n\nReference: ${c}`);
  for (let i = 0; i < 6; i++) {
    make("image-in-link", `image-in-link-${i + 1}`, (c) => {
      const path = `${folder}/image-in-link-${i + 1}.md`;
      return `# Linked picture\n\n[${imageMarkdown(path, ctx.assets.secondary)}](https://www.example.com/${word(rng)})\n\nReference: ${c}`;
    });
    (ctx.files.at(-1) as CorpusFile).links.push(ctx.assets.secondary.path);
  }
  for (const length of [CONTENT_LIMIT + 1, 260_000, 300_000]) {
    make("content-too-long", `too-long-${length}`, (c) => {
      const head = `# Archive\n\nReference: ${c}\n\n`;
      return head + asciiFiller(rng, length - head.length);
    });
  }
}

// ---------------------------------------------------------------- unsynced files

function unsynced(ctx: Context): void {
  const { rng } = ctx;
  const add = (path: string, content: string | Buffer, options: Partial<CorpusFile> = {}) => {
    ctx.taken.add(path);
    ctx.files.push(markdownFile({ path, content: typeof content === "string" ? Buffer.from(content) : content, group: "unsynced", synced: false, ...options }));
  };
  const code: [string, (c: string) => string][] = [
    ["ts", (c) => `// ${c}\nexport function total(values: number[]): number {\n  return values.reduce((a, b) => a + b, 0);\n}\n`],
    ["py", (c) => `# ${c}\ndef total(values):\n    return sum(values)\n`],
    ["sh", (c) => `#!/bin/sh\n# ${c}\necho "ready"\n`],
    ["go", (c) => `// ${c}\npackage main\n\nfunc main() {}\n`],
  ];
  for (let i = 0; i < 12; i++) {
    const [ext, make] = code[i % code.length] as [string, (c: string) => string];
    const canary = ctx.canaries.take();
    add(`${LOOSE}/scripts/tool-${i + 1}.${ext}`, make(canary), { canary, canaryIn: "content", kind: "other" });
  }
  add(`${LOOSE}/data/inventory.csv`, `id,item,count\n1,${word(rng)},${rng.int(1, 99)}\n`, { kind: "attachment" });
  for (let i = 0; i < 5; i++) add(`${LOOSE}/data/export-${i + 1}.csv`, `id,value\n1,${rng.int(1, 99)}\n`, { kind: "attachment" });
  for (let i = 0; i < 6; i++) add(`${LOOSE}/config/settings-${i + 1}.yaml`, `name: ${word(rng)}\nenabled: ${rng.bool()}\n`, { kind: "other" });
  for (let i = 0; i < 12; i++) {
    const canary = ctx.canaries.take();
    add(`${LOOSE}/notes/note-${i + 1}.md`, `# ${title(rng)}\n\n${paragraph(rng)}\n\nReference: ${canary}\n`, { canary, canaryIn: "content" });
  }
  // A binary file with a Markdown name; the canary is in its name.
  const canary = ctx.canaries.take();
  const blob = Buffer.concat([Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x89]), rng.bytes(2048)]);
  add(`${LOOSE}/binary-${canary}.md`, blob, { canary, canaryIn: "name", note: "binary content with a .md name" });
  for (let i = 0; i < 3; i++) add(`${LOOSE}/config/feature-${i + 1}.json`, `{"enabled": ${rng.bool()}}\n`, { kind: "attachment" });
}

export function documents(rng: Rng, canaries: Canaries, assets: Assets, taken: Set<string>): CorpusFile[] {
  homeCursor = 0;
  const ctx: Context = { rng, canaries, assets, files: [], taken };
  specialDocuments(ctx);
  workDocuments(ctx, 40 - 1); // the titled-image document is the fortieth user of the shared image
  pairwise(ctx);
  sizeSpectrum(ctx);
  mermaid(ctx);
  tables(ctx);
  typography(ctx);
  linksGroup(ctx);
  frontMatter(ctx);
  htmlExtensions(ctx);
  conflictMarkers(ctx);
  lintErrors(ctx);
  unsynced(ctx);
  return ctx.files;
}

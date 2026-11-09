// The generated Markdown groups of the corpus.
//
// Work documents, diagrams, tables, briefs with front matter, notes with
// HTML and extensions, weekly digests with links, and localization pages
// read like Kitewing's own documentation and live in its team and project
// folders. Pairwise construct samples, size extremes, odd names, marker
// lookalikes, lint errors and unusual typography live under eng/edge-cases/.

import { posix } from "node:path";
import { fixText } from "../../src/format/index.ts";
import type { AssetRef, Assets } from "./assets.ts";
import { COMPANY, CUSTOMERS, DEPOTS, FIXED_SERIES, PEOPLE, PROFILES, SERVICES, TOPIC_KINDS, type Kind, type Profile, type Topic } from "./company.ts";
import { CONTENT_LIMIT, destination, idLine, markdownFile, relativeLink, type Canaries, type CorpusFile, type Group } from "./model.ts";
import type { Rng } from "./rng.ts";
import { asciiFiller, capitalize, EMOJI, EMOJI_SEQUENCES, isoDate, paragraph, person, SCRIPT_SAMPLES, sentence, team, title, word } from "./text.ts";
import { BANK_HOME, EDGE, EDGE_ZONE, HOMES, LOCALIZATION, LOOSE, type Home } from "./tree.ts";
import { amount, lower as lowerFirst, slugify, weekDate, writeDocument, type Media } from "./writing.ts";

type Context = {
  rng: Rng;
  canaries: Canaries;
  assets: Assets;
  files: CorpusFile[];
  /** Paths already taken, so generated names never collide. */
  taken: Set<string>;
  fixtures: Map<string, CorpusFile>;
  /** Documents that embed the shared logo so far. */
  sharedUsers: number;
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

const ENG_HOMES = HOMES.filter((h) => h.team === "ENG");
const TOPIC_HOMES = HOMES.filter((h) => (PROFILES[h.path] as Profile).topics.length > 0);

/** Deals homes from a list in turn; the round number varies what each home gets. */
class Dealer {
  #n = 0;
  readonly homes: Home[];
  constructor(homes: Home[]) {
    this.homes = homes;
  }
  next(): { home: Home; round: number } {
    const n = this.#n++;
    return { home: this.homes[n % this.homes.length] as Home, round: Math.floor(n / this.homes.length) };
  }
}

function profileOf(home: Home): Profile {
  return PROFILES[home.path] as Profile;
}

/** The home's topics, or every topic for a home that has none of its own. */
function topicsOf(home: Home): readonly Topic[] {
  const own = profileOf(home).topics;
  return own.length > 0 ? own : Object.values(PROFILES).flatMap((p) => p.topics);
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

/** Reuse the bank's observed classification for a generated example. */
function fromFixture(ctx: Context, name: string): Pick<CorpusFile, "expected" | "rule" | "basis"> {
  const fixture = ctx.fixtures.get(`${BANK_HOME}/${name}`);
  if (!fixture?.expected || !fixture.basis) throw new Error(`missing fixture expectation: ${name}`);
  return { expected: fixture.expected, rule: fixture.rule, basis: fixture.basis };
}

/** Writes a document whose body ends with its canary line. */
function doc(ctx: Context, folder: string, name: string, group: Group, build: (canary: string, path: string) => string, options: DocOptions = {}): CorpusFile {
  const canary = ctx.canaries.take();
  const path = uniquePath(ctx, folder, name);
  return addDoc(ctx, path, build(canary, path), group, { ...options, canary });
}

function imageMarkdown(from: string, ref: AssetRef, titleText?: string): string {
  const target = destination(relativeLink(from, ref.path));
  return titleText === undefined ? `![${ref.label}](${target})` : `![${ref.label}](${target} "${titleText}")`;
}

function linkMarkdown(from: string, ref: AssetRef): string {
  return `[${ref.label}](${destination(relativeLink(from, ref.path))})`;
}

function takeAsset(ctx: Context, home: Home, kind: AssetRef["kind"], accept: (ref: AssetRef) => boolean = () => true): AssetRef | undefined {
  const queue = ctx.assets.queues.get(home.path) ?? [];
  const i = queue.findIndex((a) => a.kind === kind && accept(a));
  return i < 0 ? undefined : queue.splice(i, 1)[0];
}

function table(rows: string[][], align?: string[]): string {
  const header = rows[0] as string[];
  const sep = align ?? header.map(() => "---");
  return [header, sep, ...rows.slice(1)].map((r) => `| ${r.join(" | ")} |`).join("\n");
}

/** The logo line under the heading, for the first documents of the handbook and the help center. */
function withLogo(ctx: Context, path: string, body: string, links: string[]): string {
  if (ctx.sharedUsers >= 39 || !(path.startsWith("docs/handbook/") || path.startsWith("support/"))) return body;
  ctx.sharedUsers++;
  links.push(ctx.assets.shared.path);
  return body.replace(/^(# [^\n]*\n)/, `$1\n${imageMarkdown(path, ctx.assets.shared)}\n`);
}

// ---------------------------------------------------------------- work documents

function isDot(ref: AssetRef): boolean {
  return ref.label.endsWith("status dot");
}

/** Work documents added in the projects and team DOCS only; no Linear container may pass about 800 documents. */
const EXTRA_OUTSIDE_ENG_ZONE = 400;

type Planned = { home: Home; kind: Kind; topic: Topic | null; index: number };

/**
 * The work documents: one per topic and topic kind, the fixed series
 * (quarterly goals, newsletter, API changelog), then dated series dealt round
 * by round over every home until `total`, then `extra` more dated series in
 * the projects and team DOCS only, so team ENG's zone does not grow.
 */
function plan(total: number, extra: number): Planned[] {
  const out: Planned[] = [];
  for (const home of HOMES) {
    const profile = profileOf(home);
    for (const kind of profile.kinds.filter((k) => TOPIC_KINDS.includes(k))) {
      profile.topics.forEach((topic, index) => out.push({ home, kind, topic, index }));
    }
    for (const kind of profile.kinds) {
      for (let index = 0; index < (FIXED_SERIES[kind] ?? 0); index++) out.push({ home, kind, topic: null, index });
    }
  }
  const dated = (k: Kind) => !TOPIC_KINDS.includes(k) && FIXED_SERIES[k] === undefined;
  const series = HOMES.map((home) => ({ home, kinds: profileOf(home).kinds.filter(dated), turn: 0, next: new Map<Kind, number>() })).filter((s) => s.kinds.length > 0);
  const deal = (from: typeof series, until: number) => {
    while (out.length < until) {
      for (const s of from) {
        if (out.length >= until) break;
        const kind = s.kinds[s.turn++ % s.kinds.length] as Kind;
        const index = s.next.get(kind) ?? 0;
        s.next.set(kind, index + 1);
        out.push({ home: s.home, kind, topic: null, index });
      }
    }
  };
  deal(series, total);
  deal(series.filter((s) => s.home.scope === "project" || s.home.team === "DOCS"), total + extra);
  return out;
}

function workDocuments(ctx: Context): void {
  const { rng } = ctx;
  for (const item of plan(800, EXTRA_OUTSIDE_ENG_ZONE)) {
    const media: Media[] = [];
    const refs: AssetRef[] = [];
    for (const kind of ["image", "image", "attachment"] as const) {
      if (kind === "attachment" && !rng.bool(0.25)) continue;
      // At most one tiny status dot per document.
      const ref = takeAsset(ctx, item.home, kind, (a) => !(isDot(a) && refs.some(isDot)));
      if (ref) refs.push(ref);
    }
    const draft = writeDocument({ rng: rng.fork(`${item.home.path}/${item.kind}/${item.index}/${item.topic?.title ?? ""}`), kind: item.kind, profile: profileOf(item.home), topic: item.topic, index: item.index, media: [] });
    const path = uniquePath(ctx, `${item.home.path}/${draft.folder}`, draft.name);
    for (const ref of refs) media.push({ markdown: ref.kind === "image" ? imageMarkdown(path, ref) : linkMarkdown(path, ref), kind: ref.kind, label: ref.label });
    const final = writeDocument({ rng: rng.fork(`${item.home.path}/${item.kind}/${item.index}/${item.topic?.title ?? ""}`), kind: item.kind, profile: profileOf(item.home), topic: item.topic, index: item.index, media });
    const canary = ctx.canaries.take();
    const links = refs.map((r) => r.path);
    const body = withLogo(ctx, path, `${final.body}\n${idLine(canary)}\n`, links);
    const tooLarge = refs.find((r) => r.tooLarge);
    addDoc(ctx, path, body, "work-documents", {
      canary,
      links,
      ...(tooLarge === undefined ? {} : { rule: "upload-too-large", note: `embeds or links ${tooLarge.path}, over the upload limit` }),
    });
  }
  // Galleries for whatever is left in the queues: every asset is used at least once.
  for (const home of HOMES) {
    const queue = ctx.assets.queues.get(home.path) ?? [];
    for (let set = 1; queue.length > 0; set++) {
      const batch = queue.splice(0, 6);
      const path = uniquePath(ctx, `${home.path}/images`, `gallery-${set}`);
      const canary = ctx.canaries.take();
      const body = [
        `# ${profileOf(home).name}: screens and charts, set ${set}`,
        "",
        `Pictures collected for the ${profileOf(home).name.toLowerCase()} pages. Reuse them in your documents rather than taking new screenshots.`,
        "",
        ...batch.flatMap((ref) => (ref.kind === "image" ? [`## ${capitalize(ref.label)}`, "", imageMarkdown(path, ref), ""] : [`* ${linkMarkdown(path, ref)}`, ""])),
        idLine(canary),
        "",
      ].join("\n");
      const tooLarge = batch.find((r) => r.tooLarge);
      addDoc(ctx, path, body, "work-documents", {
        canary,
        links: batch.map((r) => r.path),
        ...(tooLarge === undefined ? {} : { rule: "upload-too-large", note: `embeds or links ${tooLarge.path}, over the upload limit` }),
      });
    }
  }
  // The shared logo needs 40 documents in all: company news fills the rest.
  for (let n = 1; ctx.sharedUsers < 39; n++) {
    ctx.sharedUsers++;
    doc(ctx, "docs/handbook/news", `company-news-${String(n).padStart(2, "0")}`, "work-documents", (canary, path) => {
      const topic = rng.pick(Object.values(PROFILES).flatMap((p) => p.topics));
      return [
        `# Company news, issue ${n}`,
        "",
        imageMarkdown(path, ctx.assets.shared),
        "",
        `Welcome to issue ${n} of the ${COMPANY} news. This time: ${topic.title.toLowerCase()}.`,
        "",
        `${topic.summary} ${topic.problem}`,
        "",
        `A warm welcome to ${rng.pick(PEOPLE)}, who joined this month. Say hello in the team channel!`,
        "",
        idLine(canary),
        "",
      ].join("\n");
    }, { links: [ctx.assets.shared.path] });
  }
}

/** A title path of exactly the given length, in segments of at most 120 characters. */
export function longTitle(length: number): string {
  const prefix = `${EDGE_ZONE.slice("eng/".length)}/long-titles/t${length}`;
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

/** Special documents: long titles, a deep path, names in other scripts, image edge cases. */
function specialDocuments(ctx: Context): void {
  const { rng } = ctx;
  // Titles are paths below the team folder, without ".md". A file name is
  // at most 255 bytes, so long titles are split across folders.
  for (const length of [100, 200, 250, 255, 256, 300]) {
    const titlePath = longTitle(length);
    const folder = `eng/${posix.dirname(titlePath)}`;
    doc(ctx, folder, posix.basename(titlePath), "work-documents", (canary) => `# A title of ${length} characters\n\nThe path of this document below the team folder is exactly ${length} characters long.\n\n${paragraph(rng)}\n\n${idLine(canary)}\n`, {
      note: `title "${titlePath}" is ${length} characters`,
    });
  }
  // Six folders deep, in the tidy part.
  doc(ctx, "eng/infra/regions/north/storage/archive", "retention-policy", "work-documents", (canary) => [
    "# Retention policy for archived storage",
    "",
    "Objects in the north region's archive tier are kept for seven years, then deleted by a lifecycle rule.",
    "",
    table([["Data", "Kept for", "Why"], ["Delivery records", "7 years", "Tax law"], ["Proof of delivery photos", "13 months", "Claims window plus one month"], ["Raw driver locations", "90 days", "Route quality analysis"]]),
    "",
    "Ask the infrastructure team before you change a lifecycle rule.",
    "",
    idLine(canary),
    "",
  ].join("\n"), { note: "six folders deep" });
  // Names with spaces, dots, parentheses, Greek, CJK and emoji.
  for (const name of ["meeting notes (draft)", "v2.1 release.plan", "Σημειώσεις συνάντησης", "会议记录", "🚀 launch checklist", "notes  with  double spaces"]) {
    doc(ctx, `${EDGE}/names`, name, "work-documents", (canary) => `# ${name}\n\nThis file name has ${/\s{2}/.test(name) ? "double spaces" : /[^\x20-\x7e]/.test(name) ? "characters outside ASCII" : "spaces, dots or parentheses"}.\n\n${paragraph(rng)}\n\n${idLine(canary)}\n`);
  }
  // Image edge cases.
  doc(ctx, `${EDGE}/images`, "broken-image", "work-documents", (canary) => `# Missing picture\n\n![diagram that is not there](./missing/diagram.png)\n\n${idLine(canary)}\n`, { note: "a broken image reference" });
  doc(ctx, `${EDGE}/images`, "remote-image", "work-documents", (canary) => `# Remote picture\n\n![remote chart](https://images.example.com/chart.png)\n\n${idLine(canary)}\n`, { note: "a remote image URL" });
  const titled = ctx.assets.shared;
  doc(ctx, `${EDGE}/images`, "titled-image", "work-documents", (canary, path) => `# Picture with a title\n\n${imageMarkdown(path, titled, "Company logo, light version")}\n\n${idLine(canary)}\n`, {
    ...fromFixture(ctx, "images/title.md"),
    links: [titled.path],
    note: "an image with a title",
  });
  // Files over and near the upload limit.
  const [scan, ...pdfs] = ctx.assets.oversized as [AssetRef, ...AssetRef[]];
  doc(ctx, `${EDGE}/images`, "large-uploads", "work-documents", (canary, path) => [
    "# Large uploads",
    "",
    imageMarkdown(path, scan),
    "",
    ...pdfs.map((p) => `* ${linkMarkdown(path, p)}`),
    "",
    idLine(canary),
    "",
  ].join("\n"), { links: ctx.assets.oversized.map((r) => r.path), rule: "upload-too-large", note: `embeds or links ${ctx.assets.oversized.filter((r) => r.tooLarge).map((r) => r.path).join(" and ")}, over the upload limit` });
}

// ---------------------------------------------------------------- pairwise

const INLINE: [string, (rng: Rng) => string][] = [
  ["code", () => `\`${pickService()}\``],
  ["bold", (rng) => `**${word(rng)}**`],
  ["italic", (rng) => `*${word(rng)}*`],
  ["strike", (rng) => `~~${word(rng)}~~`],
  ["link", (rng) => `[${word(rng)} notes](https://www.example.com/${word(rng)})`],
  ["math", () => "$a^2 + b^2$"],
  ["emoji", (rng) => rng.pick(EMOJI)],
  ["underline", (rng) => `<u>${word(rng)}</u>`],
  ["highlight", (rng) => `==${word(rng)}==`],
  ["bold-italic", (rng) => `***${word(rng)}***`],
];

let serviceCursor = 0;
function pickService(): string {
  return SERVICES[serviceCursor++ % SERVICES.length] as string;
}

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
  ["code-in-list", () => `* Check the service first.\n\n  \`\`\`sh\n  kw status ${pickService()} --check\n  \`\`\``],
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
    const imageRef = n % 15 === 0 ? ctx.assets.secondary : undefined;
    const path = uniquePath(ctx, `${EDGE}/formatting`, `${name}-${Math.floor(n / combos.length) + 1}`);
    const canary = ctx.canaries.take();
    const parts = [`# ${capitalize(name.replace(/-/g, " "))}`, "", make(rng), ""];
    if (imageRef) parts.push(`* ${sentence(rng)} ${imageMarkdown(path, imageRef)}`, "", `| Preview |\n| -- |\n| ${imageMarkdown(path, imageRef)} |`, "");
    parts.push(idLine(canary), "");
    addDoc(ctx, path, parts.join("\n"), "pairwise", { canary, links: imageRef ? [imageRef.path] : [] });
    n++;
  }
}

// ---------------------------------------------------------------- size spectrum

/** Plain prose of exactly `length` characters that `fix` leaves as it is. */
export function exactInLinearForm(text: string, length: number): string {
  // Linear's form has no trailing whitespace, so cut, trim and pad the last word.
  let out = fixText(text).slice(0, length).replace(/\s+$/, "");
  out += "x".repeat(length - out.length);
  if (out.length !== length || fixText(out) !== out) throw new Error(`cannot write ${length} characters in Linear's form`);
  return out;
}

function sizeSpectrum(ctx: Context): void {
  const { rng } = ctx;
  const folder = `${EDGE}/sizes`;
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
    const head = `# ${capitalize(name.replace(/-/g, " "))}\n\n${idLine(canary)}\n\n`;
    const text = head + asciiFiller(rng, length - head.length);
    // Over Linear's limit the text is a lint error and stays as it is; below it, the
    // size is exact in Linear's form, so writing the corpus through fix keeps it.
    addDoc(ctx, uniquePath(ctx, folder, name), options.expected === "lint-error" ? text : exactInLinearForm(text, length), "size-spectrum", { canary, note, ...options });
  };
  for (let i = 0; i < 5; i++) {
    const canary = ctx.canaries.take();
    addDoc(ctx, uniquePath(ctx, folder, `one-line-${i + 1}`), `${sentence(rng)} ${idLine(canary)}${i % 2 === 0 ? "\n" : ""}`, "size-spectrum", { canary, note: "one line" });
  }
  const ladder: [string, number, number][] = [["size-1kb", 1_000, 8], ["size-10kb", 10_000, 8], ["size-100kb", 100_000, 5], ["size-240kb", 240_000, 4]];
  for (const [name, length, count] of ladder) for (let i = 0; i < count; i++) sized(`${name}-${i + 1}`, length, `${length} characters`);
  sized("at-limit-minus-one", CONTENT_LIMIT - 1, `${CONTENT_LIMIT - 1} characters, just under Linear's limit`);
  sized("at-limit", CONTENT_LIMIT, `${CONTENT_LIMIT} characters, exactly Linear's limit`);
  sized("size-260kb", 260_000, "260,000 characters, over Linear's limit", { expected: "lint-error", rule: "content-too-long", basis: "known" });
  for (let i = 0; i < 3; i++) {
    const canary = ctx.canaries.take();
    const line = `${idLine(canary)} ${asciiFiller(rng, 100_000).replace(/\s+/g, " ")}`.slice(0, 100_000);
    addDoc(ctx, uniquePath(ctx, folder, `single-line-100k-${i + 1}`), line, "size-spectrum", { canary, note: "one line of 100,000 characters" });
  }
  // Fill the group to at least 50 with mid sizes.
  let k = 1;
  while (ctx.files.filter((f) => f.group === "size-spectrum").length < 50) sized(`size-5kb-${k++}`, 5_000, "5,000 characters");
}

// ---------------------------------------------------------------- mermaid

type Diagram = { headline: string; caption: string; source: (rng: Rng, profile: Profile) => string };

const DIAGRAMS: Record<string, Diagram> = {
  flowchart: {
    headline: "how work flows",
    caption: "Each step hands its result to the next one; the dotted line is the feedback loop.",
    source: (rng, p) => [`flowchart ${rng.bool() ? "LR" : "TD"}`, ...p.labels.map((l, i) => `    S${i}[${capitalize(l.toLowerCase())}]`), ...p.labels.slice(1).map((_, i) => `    S${i} --> S${i + 1}`), `    S${p.labels.length - 1} -. feedback .-> S0`].join("\n"),
  },
  sequence: {
    headline: "a request end to end",
    caption: "What happens between the console and the services when a planner publishes a route.",
    source: (rng) => [
      "sequenceDiagram",
      "    actor Planner",
      "    participant Console",
      `    participant API as ${rng.pick(["dispatch-api", "order-intake"])}`,
      "    participant Planner2 as route-planner",
      "    Planner->>Console: Publish routes",
      "    Console->>API: POST /v2/routes",
      "    API->>Planner2: Plan request",
      "    Planner2-->>API: Plan ready",
      "    API-->>Console: 201 Created",
      "    Note right of API: Drivers get the routes within a minute",
    ].join("\n"),
  },
  class: {
    headline: "the main entities",
    caption: "The entities that every service shares.",
    source: () => ["classDiagram", "    class Depot {", "      +String name", "      +openingHours()", "    }", "    class Route {", "      +Date day", "      +publish()", "    }", "    class Stop {", "      +String address", "      +Window window", "    }", "    Depot \"1\" --> \"*\" Route", "    Route \"1\" --> \"*\" Stop"].join("\n"),
  },
  state: {
    headline: "the life of an order",
    caption: "An order's states from the moment a shop sends it.",
    source: () => ["stateDiagram-v2", "    [*] --> Received", "    Received --> Planned", "    Planned --> OutForDelivery", "    OutForDelivery --> Delivered", "    OutForDelivery --> Failed", "    Failed --> Planned: next day", "    Delivered --> [*]"].join("\n"),
  },
  er: {
    headline: "the data model",
    caption: "Tables and how they relate.",
    source: () => ["erDiagram", "    DEPOT ||--o{ ROUTE : plans", "    ROUTE ||--|{ STOP : contains", "    ORDER ||--o{ PARCEL : ships", "    STOP }o--|| ORDER : serves"].join("\n"),
  },
  gantt: {
    headline: "the plan for the quarter",
    caption: "Dates are targets, not promises.",
    source: (rng, p) => ["gantt", `    title ${p.name}, next quarter`, "    dateFormat YYYY-MM-DD", "    section Build", `    ${(p.topics[0]?.title ?? "First milestone").replace(/:/g, "")} :a1, ${weekDate(rng.int(40, 50))}, 14d`, `    ${(p.topics[1]?.title ?? "Second milestone").replace(/:/g, "")} :after a1, 21d`, "    section Rollout", "    Pilot depot :b1, after a1, 7d", "    All depots :after b1, 14d"].join("\n"),
  },
  pie: {
    headline: "where the time goes",
    caption: "Share of last month's engineering time.",
    source: (rng) => ["pie title Engineering time last month", `    "New features" : ${rng.int(30, 50)}`, `    "Maintenance" : ${rng.int(15, 30)}`, `    "Incidents" : ${rng.int(5, 15)}`, `    "Support" : ${rng.int(5, 15)}`].join("\n"),
  },
  journey: {
    headline: "a planner's morning",
    caption: "Scores from interviews with planners: 5 is great, 1 is painful.",
    source: (rng) => ["journey", "    title A planner's morning", "    section Before the vans leave", `      Import orders: ${rng.int(2, 5)}: Planner`, `      Check the plan: ${rng.int(2, 5)}: Planner`, `      Publish routes: ${rng.int(3, 5)}: Planner, Driver`, "    section During the day", `      Handle a new order: ${rng.int(1, 4)}: Planner`].join("\n"),
  },
  gitGraph: {
    headline: "how releases are branched",
    caption: "Fixes go to main first and are picked into the release branch.",
    source: () => ["gitGraph", "    commit", "    commit", "    branch release", "    checkout release", "    commit", "    checkout main", "    commit id: \"fix\"", "    checkout release", "    cherry-pick id: \"fix\""].join("\n"),
  },
  mindmap: {
    headline: "what we are working on",
    caption: "Current work, grouped by theme.",
    source: (_rng, p) => ["mindmap", `  root((${p.name}))`, ...p.topics.slice(0, 4).map((tp) => `    ${tp.title.replace(/[()]/g, "")}`)].join("\n"),
  },
  timeline: {
    headline: "how we got here",
    caption: "Milestones of the last two years.",
    source: (_rng, p) => ["timeline", `    title ${p.name} history`, "    2024 : First version : Two depots", "    2025 : All depots in eu-west : Partner API", "    2026 : Three regions : Driver app 3"].join("\n"),
  },
  quadrant: {
    headline: "what to do first",
    caption: "Work items by effort and value, from the last planning meeting.",
    source: (rng, p) => ["quadrantChart", "    title Effort and value", "    x-axis Low effort --> High effort", "    y-axis Low value --> High value", ...p.topics.slice(0, 4).map((tp) => `    ${tp.title.replace(/[:()]/g, "")}: [${(rng.int(10, 90) / 100).toFixed(2)}, ${(rng.int(10, 90) / 100).toFixed(2)}]`)].join("\n"),
  },
};

function mermaid(ctx: Context): void {
  const { rng } = ctx;
  const kinds = Object.keys(DIAGRAMS);
  const dealer = new Dealer(ENG_HOMES);
  for (let i = 0; i < 60; i++) {
    const { home, round } = dealer.next();
    const profile = { ...profileOf(home), topics: topicsOf(home) };
    const count = 1 + (i % 4);
    const lead = (i % ENG_HOMES.length) + round * 5;
    const chosen = Array.from({ length: count }, (_, k) => kinds[(lead + k * 5) % kinds.length] as string);
    const invalid = i % 20 === 7;
    const main = DIAGRAMS[chosen[0] as string] as Diagram;
    const folder = invalid ? `${EDGE}/diagrams` : `${home.path}/architecture`;
    doc(ctx, folder, slugify(main.headline), "mermaid", (canary) => {
      const parts = [`# ${profile.name}: ${main.headline}`, "", profile.about, ""];
      for (const kind of chosen) {
        const d = DIAGRAMS[kind] as Diagram;
        parts.push(`## ${capitalize(d.headline)}`, "", d.caption, "", "```mermaid", d.source(rng, profile), "```", "");
      }
      if (invalid) parts.push("## Draft", "", "This sketch was never finished.", "", "```mermaid", "flowchart LR\n    A --> \n    this is not a diagram ((", "```", "");
      parts.push(idLine(canary), "");
      return parts.join("\n");
    }, { note: invalid ? `${chosen.join(", ")}, and an invalid diagram` : chosen.join(", ") });
  }
}

// ---------------------------------------------------------------- tables

function tables(ctx: Context): void {
  const { rng } = ctx;
  const kinds = ["aligned", "wide", "long", "empty-cells", "inline-marks", "code-pipes", "links-images", "unicode", "plain"] as const;
  const dealer = new Dealer(ENG_HOMES);
  for (let i = 0; i < 120; i++) {
    const { home, round } = dealer.next();
    const profile = profileOf(home);
    // Aligned tables keep their fixed positions; the other kinds rotate over the homes.
    const kind = (i % kinds.length === 0 ? "aligned" : kinds[1 + ((i + round) % (kinds.length - 1))]) as (typeof kinds)[number];
    const links: string[] = [];
    let heading: string;
    let folder = `${home.path}/reference`;
    let intro: string;
    let body: (path: string) => string;
    switch (kind) {
      case "aligned":
        folder = `${EDGE}/tables`;
        heading = "Aligned columns";
        intro = "Column alignment set with colons in the separator row.";
        body = () => table([["Depot", "Vans", "Deliveries"], ...Array.from({ length: 4 }, () => [rng.pick(DEPOTS), String(rng.int(4, 40)), String(rng.int(100, 999))])], [":--", ":-:", "--:"]);
        break;
      case "wide": {
        const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][(i + round * 5) % 12] as string;
        folder = `${home.path}/reports`;
        heading = `Deliveries per day, ${month} 2026`;
        intro = `One row per depot, one column per day of ${month}. Copied from the monthly export.`;
        body = () => table([["Depot", ...Array.from({ length: 29 }, (_, d) => String(d + 1))], ...rng.shuffle(DEPOTS).slice(0, 3).map((dep) => [dep, ...Array.from({ length: 29 }, () => String(rng.int(80, 400)))])]);
        break;
      }
      case "long": {
        const big = i % 18 === 2;
        folder = `${home.path}/reports`;
        heading = big ? `Parcel lockers, full list (${rng.pick(DEPOTS)} region)` : `Stops on route ${rng.int(10, 99)}, ${weekDate(rng.int(0, 60), rng.int(0, 4))}`;
        intro = big ? "Every parcel locker we deliver to, with its slot count. Updated weekly." : "The planned order of stops, as published to the driver.";
        body = () => big
          ? table([["#", "Locker", "Depot", "Slots"], ...Array.from({ length: 500 }, (_, r) => [String(r + 1), `${rng.pick(["Station", "Mall", "Campus", "Library", "Garage", "Market"])} ${String(r + 1).padStart(3, "0")}`, rng.pick(DEPOTS), String(rng.int(12, 96))])])
          : table([["#", "Customer", "Window", "Parcels"], ...Array.from({ length: 60 }, (_, r) => [String(r + 1), rng.pick(CUSTOMERS), `${String(8 + Math.floor(r / 8)).padStart(2, "0")}:00-${String(10 + Math.floor(r / 8)).padStart(2, "0")}:00`, String(rng.int(1, 6))])]);
        break;
      }
      case "empty-cells":
        heading = `Feature availability by plan, ${["spring", "summer", "autumn", "winter"][round % 4]} ${2025 + Math.floor(round / 4)}`;
        intro = "An empty cell means the feature is not available on that plan.";
        body = () => table([["Feature", "Starter", "Team", "Enterprise"], ["Live arrival windows", "", "Yes", "Yes"], ["Multi-depot planning", "", "", "Yes"], ["Partner API", "Yes", "Yes", "Yes"], ["Proof of delivery photos", "", "Yes", ""]]);
        break;
      case "inline-marks":
        heading = `Service status, week of ${weekDate(round * 5 + (i % 5))}`;
        intro = "Status of each service this week. Struck-through items are resolved.";
        body = () => table([["Service", "Status", "Note"], ...rng.shuffle(SERVICES).slice(0, 4).map((s, k) => [`\`${s}\``, ["**Degraded**", "*Watching*", "~~Incident~~ resolved", "Healthy"][k] as string, ["Latency above target since Monday", "One alert last night", "Fixed by the rollback", "No issues"][k] as string])]);
        break;
      case "code-pipes":
        heading = `Command cheat sheet: ${SERVICES[(i + round * 3) % SERVICES.length]}`;
        intro = "Commands we use most. Pipes inside code are escaped so the table stays intact.";
        body = () => table([["Command", "What it does"], ["`kw logs api \\| grep 500`", "Show server errors"], ["`kw routes list \\|\\| echo none`", "List routes or say none"], ["`kw deploys list`", "Recent deploys"]]);
        break;
      case "links-images": {
        const ref = ctx.assets.secondary;
        links.push(ref.path);
        heading = `Who to ask about ${lowerFirst(topicsOf(home)[round % topicsOf(home).length]?.title ?? "anything")}`;
        intro = "Who to ask about what. A green check means the person is on call this week.";
        body = (path) => table([["Name", "Ask about", "On call"], ...PEOPLE.slice((i * 3) % 18, ((i * 3) % 18) + 3).map((p, k) => [`[${p}](https://people.example.com/${slugify(p)})`, rng.pick(topicsOf(home)).title, k === 0 ? imageMarkdown(path, ref) : ""])]);
        break;
      }
      case "unicode":
        folder = `${LOCALIZATION}/reference`;
        heading = Math.floor(i / 9) === 0 ? "Language names" : `Language names, part ${Math.floor(i / 9) + 1}`;
        intro = "How each language we support writes the sentence used in the driver app's onboarding screen.";
        body = () => table([["Language", "Sample"], ...Object.entries(SCRIPT_SAMPLES).map(([k, v]) => [capitalize(k), v[0] as string]), ["Emoji", EMOJI_SEQUENCES.slice(0, 3).join(" ")]]);
        break;
      case "plain":
        heading = `Contacts for ${lowerFirst(topicsOf(home)[(round + 2) % topicsOf(home).length]?.title ?? "the team")}`;
        intro = "The quickest way to reach the team.";
        body = () => table([["Channel", "Use it for"], ["Team chat", "Questions and quick help"], ["Ticket queue", "Anything that can wait a day"]]);
        break;
    }
    const name = kind === "aligned" ? `aligned-${i + 1}` : slugify(heading);
    const path = uniquePath(ctx, folder, name);
    const canary = ctx.canaries.take();
    addDoc(ctx, path, `# ${heading}\n\n${intro}\n\n${body(path)}\n\n${idLine(canary)}\n`, "tables", {
      canary, links, note: kind === "long" ? "long table" : kind === "wide" ? "30 columns" : null,
      ...(kind === "aligned" ? fromFixture(ctx, "tables/table-alignment.md") : {}),
    });
  }
  doc(ctx, `${EDGE}/tables`, "escaped-pipe-plain-cell", "tables", (canary) => `# Escaped pipe\n\n${table([["Choice", "Value"], ["either", "a \\| b"]])}\n\n${idLine(canary)}\n`, {
    expected: "lint-error",
    rule: "table-escaped-pipe",
    basis: "known",
    note: "an escaped pipe in a plain cell splits the row",
  });
}

// ---------------------------------------------------------------- typography and scripts

const LOCALES: Record<string, { folder: string; language: string; english: string[] }> = {
  greek: { folder: "Ελληνικά (el)", language: "Greek", english: ["The meeting is tomorrow morning.", "Update the project board.", "All the best, everyone."] },
  chinese: { folder: "中文 (zh)", language: "Chinese", english: ["The meeting notes have been updated.", "Please finish the review before Friday.", "The project plan needs more discussion."] },
  japanese: { folder: "日本語 (ja)", language: "Japanese", english: ["The meeting is tomorrow morning.", "Please share the materials.", "I checked the progress."] },
  korean: { folder: "한국어 (ko)", language: "Korean", english: ["The meeting is tomorrow morning.", "Please review the document.", "The schedule has changed."] },
  arabic: { folder: "العربية (ar)", language: "Arabic", english: ["The meeting is tomorrow morning.", "Please review the plan.", "The schedule has been updated."] },
  hebrew: { folder: "עברית (he)", language: "Hebrew", english: ["The meeting is tomorrow morning.", "Please update the document.", "The plan was approved."] },
  devanagari: { folder: "हिन्दी (hi)", language: "Hindi", english: ["The meeting is tomorrow morning.", "Please review the plan.", "The list has been updated."] },
  thai: { folder: "ไทย (th)", language: "Thai", english: ["The meeting is tomorrow morning.", "Please check the document.", "The plan has been approved."] },
};
const LOCALE_PAGES = ["Team phrases", "Glossary", "Style notes", "Review checklist", "Delivery messages", "Driver app strings", "Release note translation", "Support macros"];

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
  const pagesUsed = new Map<string, number>();
  for (let i = 0; i < 120; i++) {
    const [name, make] = features[i % features.length] as [string, (rng: Rng) => string];
    const ending = i % 10 === 4 ? "crlf" : i % 10 === 7 ? "bom" : "lf";
    const canary = ctx.canaries.take();
    const locale = LOCALES[name];
    let text: string;
    let path: string;
    if (locale) {
      const n = pagesUsed.get(name) ?? 0;
      pagesUsed.set(name, n + 1);
      const page = LOCALE_PAGES[n % LOCALE_PAGES.length] as string;
      const samples = SCRIPT_SAMPLES[name] as string[];
      path = uniquePath(ctx, `${LOCALIZATION}/${locale.folder}`, slugify(page));
      text = [
        `# ${locale.language}: ${page.toLowerCase()}`,
        "",
        `Reviewed by ${rng.pick(PEOPLE)} on ${weekDate(rng.int(10, 60))}. Keep translations short: driver app buttons have room for about twenty characters.`,
        "",
        table([["English", locale.language], ...locale.english.map((en, k) => [en, samples[k] as string])]),
        "",
        "## Sample paragraph",
        "",
        make(rng),
        "",
        idLine(canary),
        "",
      ].join("\n");
    } else {
      path = uniquePath(ctx, `${EDGE}/typography`, `${name}-${i + 1}`);
      text = `# ${capitalize(name.replace(/-/g, " "))} ${i + 1}\n\n${make(rng)}\n\n${paragraph(rng)}\n\n${idLine(canary)}\n`;
    }
    if (ending === "crlf") text = text.replace(/\n/g, "\r\n");
    const content = ending === "bom" ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]) : Buffer.from(text);
    addDoc(ctx, path, content, "typography-scripts", {
      canary,
      note: ending === "lf" ? null : ending === "crlf" ? "CRLF line endings" : "starts with a byte order mark",
    });
  }
}

// ---------------------------------------------------------------- links

function linksGroup(ctx: Context): void {
  const { rng } = ctx;
  const folder = "eng/frontend/guides";
  // Targets first, so links can point at them; they count in the group too.
  const pages: [string, string, string][] = [
    ["overview", "Web overview", "The dispatch console is a single-page app that talks to the dispatch API. Planners use it from the first import in the morning until the last van is back."],
    ["setup guide", "Setup guide", "Install Node 24, clone the console repository and run the development server against the staging API. Ask for a staging account in the team channel."],
    ["faq (draft)", "Frequently asked questions (draft)", "Answers to the questions new web engineers ask in their first month. This page is a draft: add your question at the end."],
    ["notes.v1", "Architecture notes, version 1", "The first architecture notes, kept for history. Most of it still holds, but the state handling has changed since."],
    ["glossary", "Glossary", "Depot: where vans load. Route: the ordered stops of one van for one day. Window: the time a customer accepts a delivery."],
  ];
  const targets = pages.map(([name, heading, text]) => doc(ctx, folder, name, "links", (canary) => `# ${heading}\n\n${text}\n\n## Details\n\n${paragraph(rng)}\n\n${idLine(canary)}\n`));
  const unsynced = `${LOOSE}/data/inventory.csv`;
  for (let i = 0; i < 75; i++) {
    const home = nextHome();
    const path = uniquePath(ctx, `${home.path}/digests`, `weekly-digest-${String(i + 1).padStart(2, "0")}`);
    const target = targets[i % targets.length] as CorpusFile;
    const rel = relativeLink(path, target.path);
    const forms = [
      `New to the console? Start with [the ${posix.basename(target.path, ".md")} page](${destination(rel)}).`,
      `The [details section](${destination(`${rel}#details`)}) was updated this week.`,
      `Raw numbers are in [the inventory export](${destination(relativeLink(path, unsynced))}), which stays in the shared workspace.`,
      `Worth reading: [a post on route planning](https://www.example.com/${word(rng)}) and <https://www.example.org/${word(rng)}>.`,
      `Read [the style guide][guide] before your next review.\n\n[guide]: https://www.example.com/guide`,
      `Questions? Write to [the team](mailto:team@example.com).`,
      `Two links people asked about: [the draft plan](https://www.example.com/page_(draft)) and [the shared notes](<https://www.example.com/a page>).`,
    ];
    const chosen = [forms[i % forms.length] as string, forms[(i + 3) % forms.length] as string];
    const canary = ctx.canaries.take();
    const links = chosen.some((f) => f.includes(rel)) ? [target.path] : [];
    if (chosen.some((f) => f.includes("inventory"))) links.push(unsynced);
    const tp = rng.pick(topicsOf(home));
    addDoc(ctx, path, `# Weekly digest ${i + 1}: ${profileOf(home).name.toLowerCase()}\n\n${progressLine(tp)}\n\n${chosen.join("\n\n")}\n\n${idLine(canary)}\n`, "links", { canary, links });
  }
}

function progressLine(tp: Topic): string {
  return `This week: ${tp.title.toLowerCase()}. ${tp.summary}`;
}

// ---------------------------------------------------------------- front matter

function frontMatter(ctx: Context): void {
  const { rng } = ctx;
  const dealer = new Dealer(TOPIC_HOMES);
  for (let i = 0; i < 60; i++) {
    const { home, round } = dealer.next();
    const canary = ctx.canaries.take();
    const only = i % 10 === 9;
    const tp = topicsOf(home)[round % topicsOf(home).length] as Topic;
    const [owner, ...reviewers] = rng.shuffle(PEOPLE).slice(0, 3);
    const yaml = [
      `title: "${tp.title}"`,
      `owner: ${owner}`,
      `date: ${isoDate(rng)}`,
      `status: ${rng.pick(["draft", "in review", "approved"])}`,
      `tags: [${slugify(profileOf(home).name)}, ${tp.system}]`,
      "reviewers:",
      ...reviewers.map((r) => `  - ${r}`),
      "meta:",
      `  team: ${team(rng)}`,
      "  budget:",
      `    weeks: ${rng.int(2, 12)}`,
      "summary: |",
      `  ${tp.summary}`,
      `  ${tp.change}`,
      `title_el: "${SCRIPT_SAMPLES.greek?.[0]} ${rng.pick(EMOJI)}"`,
      `reference: ${canary}`,
    ];
    if (only) {
      addDoc(ctx, uniquePath(ctx, `${EDGE}/front-matter`, `metadata-only-${i + 1}`), `---\n${yaml.join("\n")}\n---\n`, "front-matter", { canary, note: "front matter only" });
      continue;
    }
    const body = [
      `# Brief: ${tp.title}`,
      "",
      "## Problem",
      "",
      tp.problem,
      "",
      "## What we will do",
      "",
      tp.change,
      "",
      `We will call it done when the ${tp.metric} is at or ${tp.after < tp.before ? "below" : "above"} ${amount(tp.after, tp.unit)}.`,
      "",
    ].join("\n");
    addDoc(ctx, uniquePath(ctx, `${home.path}/briefs`, slugify(tp.title)), `---\n${yaml.join("\n")}\n---\n\n${body}`, "front-matter", { canary });
  }
}

// ---------------------------------------------------------------- HTML and extensions

function htmlExtensions(ctx: Context): void {
  const { rng } = ctx;
  const forms: [string, (rng: Rng, p: Profile, tp: Topic, n: number) => [string, string]][] = [
    ["charter", (_r, p) => [`${p.name} team charter`, `<div align="center">\n  <strong>${p.about}</strong>\n</div>\n\nWe meet weekly, write things down and review each other's work within a day.`]],
    ["draft", (_r, _p, tp) => [`Draft: ${tp.title.toLowerCase()}`, `<!-- Add last week's numbers before sharing. -->\n\n${tp.summary} ${tp.problem}`]],
    ["review-notes", (_r, _p, tp) => [`${tp.title}: notes for reviewers`, `${tp.summary}\n\n<details>\n<summary>Background</summary>\n\n${tp.problem}\n\n</details>\n\n<details>\n<summary>What could go wrong</summary>\n\n${tp.risk}\n\n</details>`]],
    ["glossary", (_r, p) => [`${p.name} glossary`, `Depot\n: A building where vans are loaded.\n\nRoute\n: The ordered stops of one van for one day.\n\nTime window\n: The hours in which a customer accepts a delivery.`]],
    ["maintenance", (r) => [`Maintenance notice, ${weekDate(r.int(20, 60), r.int(0, 4))}`, `> [!NOTE]\n> The console will be read-only between 05:00 and 05:30 UTC while we upgrade the database. Drivers are not affected.`]],
    ["known-issue", (_r, _p, tp) => [`Known issue: ${tp.title.toLowerCase()}`, `> [!WARNING]\n> ${tp.problem}\n\n${tp.change}`]],
    ["capacity", (r) => [`Capacity estimate, ${r.pick(DEPOTS)} depot`, `With $v$ vans of $c$ parcels each and a fill rate of $f$, the depot ships $v \\times c \\times f$ parcels a day. Today that is $${r.int(10, 30)} \\times 120 \\times 0.8$.`]],
    ["formula", () => ["How we estimate route length", "The planner estimates the length of a route with $n$ stops in an area $A$ as\n\n$$\nL \\approx 0.75 \\sqrt{n A}\n$$\n\nThe constant comes from our own routes of the last year."]],
    ["kudos", (r) => [`Kudos, week ${r.int(1, 52)}`, `:tada: Thanks to ${r.pick(PEOPLE)} for the quick fix on Tuesday, and :rocket: to everyone who helped with the launch. :clap:`]],
    ["checklist", (_r, _p, tp) => [`Checklist: ${tp.title.toLowerCase()}`, `* [ ] ${tp.change}\n* [x] Agree on the measure: ${tp.metric}\n* [ ] Tell support before the rollout`]],
  ];
  const dealer = new Dealer(TOPIC_HOMES);
  for (let i = 0; i < 100; i++) {
    const { home, round } = dealer.next();
    const profile = profileOf(home);
    const tp = topicsOf(home)[round % topicsOf(home).length] as Topic;
    const [name, make] = forms[i % forms.length] as [string, (rng: Rng, p: Profile, tp: Topic, n: number) => [string, string]];
    const [heading, body] = make(rng, profile, tp, i);
    doc(ctx, `${home.path}/notes`, slugify(heading), "html-extensions", (canary) => `# ${heading}\n\n${body}\n\n${idLine(canary)}\n`, { note: name });
  }
}

// ---------------------------------------------------------------- conflict-marker lookalikes

function conflictMarkers(ctx: Context): void {
  const markers = "<<<<<<< ours\nthe old line\n=======\nthe new line\n>>>>>>> theirs";
  const forms: [string, string, (s: string) => string][] = [
    ["conflict-markers/in-code-fence.md", "In a code block, the markers look like this:", (s) => `\`\`\`text\n${s}\n\`\`\``],
    // Blank quote lines prevent the equals marker from becoming a setext heading.
    ["conflict-markers/in-quote.md", "Someone pasted the markers into a quote:", (s) => s.split("\n").map((l) => `> ${l}`).join("\n>\n")],
    ["conflict-markers/in-inline-code.md", "Written inline, the markers look like this:", () => "`<<<<<<< ours` and `=======` and `>>>>>>> theirs`."],
    ["conflict-markers/diff3-in-fence.md", "With the diff3 style, Git also shows the common base:", (s) => `\`\`\`text\n${s.replace("=======", "||||||| base\nthe base line\n=======")}\n\`\`\``],
    ["conflict-markers/in-indented-code.md", "Indented four spaces, the markers are code:", (s) => `    ${s.split("\n").join("\n    ")}`],
  ];
  for (let i = 0; i < 10; i++) {
    const [fixture, intro, form] = forms[i % forms.length] as [string, string, (s: string) => string];
    doc(ctx, `${EDGE}/merges`, `marker-lookalike-${i + 1}`, "conflict-markers", (canary) => `# How merge conflicts look\n\nWhen two people change the same line, Git stops and marks both versions. ${intro}\n\n${form(markers)}\n\n${idLine(canary)}\n`, {
      ...fromFixture(ctx, fixture),
      note: "git marker examples outside a sync conflict",
    });
  }
}

// ---------------------------------------------------------------- lint errors

function lintErrors(ctx: Context): void {
  const { rng } = ctx;
  const folder = `${EDGE}/needs-fixing`;
  const make = (rule: string, name: string, body: (canary: string, path: string) => string) =>
    // Every rule here has been observed in Linear, so its basis is "known".
    doc(ctx, folder, name, "lint-errors", body, { expected: "lint-error", rule, basis: "known" });
  for (let i = 0; i < 8; i++) make("footnote", `footnote-${i + 1}`, (c) => `# Sources\n\n${sentence(rng)}[^${i + 1}]\n\n[^${i + 1}]: ${sentence(rng)}\n\n${idLine(c)}\n`);
  for (let i = 0; i < 7; i++) make("subscript", `subscript-${i + 1}`, (c) => `# Formula\n\nWater is H~2~O and ${word(rng)}~${i + 1}~ follows.\n\n${idLine(c)}\n`);
  for (let i = 0; i < 6; i++) make("table-escaped-pipe", `escaped-pipe-${i + 1}`, (c) => `# Options\n\n${table([["Option", "Values"], [word(rng), "a \\| b"]])}\n\n${idLine(c)}\n`);
  for (let i = 0; i < 6; i++) {
    make("image-in-link", `image-in-link-${i + 1}`, (c, path) => {
      return `# Linked picture\n\n[${imageMarkdown(path, ctx.assets.secondary)}](https://www.example.com/${word(rng)})\n\n${idLine(c)}\n`;
    });
    (ctx.files.at(-1) as CorpusFile).links.push(ctx.assets.secondary.path);
  }
  for (const length of [CONTENT_LIMIT + 1, 260_000, 300_000]) {
    make("content-too-long", `too-long-${length}`, (c) => {
      const head = `# Archive\n\n${idLine(c)}\n\n`;
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
  const code: [string, string, (c: string) => string][] = [
    ["export-routes", "py", (c) => `# ${c}\n"""Export yesterday's routes as CSV."""\nimport csv\nimport sys\n\n\ndef main(rows):\n    writer = csv.writer(sys.stdout)\n    writer.writerow(["route", "stops", "km"])\n    for row in rows:\n        writer.writerow(row)\n`],
    ["check-depots", "sh", (c) => `#!/bin/sh\n# ${c}\n# Print the opening hours of every depot.\nfor depot in harbor northgate riverside; do\n  echo "$depot: 06:00"\ndone\n`],
    ["route-totals", "ts", (c) => `// ${c}\nexport function totalKilometers(legs: number[]): number {\n  return legs.reduce((sum, leg) => sum + leg, 0);\n}\n`],
    ["window-check", "go", (c) => `// ${c}\npackage main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("windows ok")\n}\n`],
  ];
  for (let i = 0; i < 12; i++) {
    const [base, ext, make] = code[i % code.length] as [string, string, (c: string) => string];
    const canary = ctx.canaries.take();
    add(`${LOOSE}/scripts/${base}-${Math.floor(i / code.length) + 1}.${ext}`, make(canary), { canary, canaryIn: "content", kind: "other" });
  }
  add(`${LOOSE}/data/inventory.csv`, `id,item,count\n1,${word(rng)},${rng.int(1, 99)}\n`, { kind: "attachment" });
  for (let i = 0; i < 5; i++) add(`${LOOSE}/data/export-${i + 1}.csv`, `depot,deliveries\n${rng.pick(DEPOTS)},${rng.int(100, 999)}\n`, { kind: "attachment" });
  for (let i = 0; i < 6; i++) add(`${LOOSE}/config/depot-${i + 1}.yaml`, `depot: ${rng.pick(DEPOTS)}\nopens: "0${rng.int(5, 7)}:00"\nlunch_break: ${rng.bool()}\n`, { kind: "other" });
  for (let i = 0; i < 12; i++) {
    const canary = ctx.canaries.take();
    const tp = title(rng);
    add(`${LOOSE}/notes/${person(rng).toLowerCase()}-${i + 1}.md`, `# Personal notes: ${tp.toLowerCase()}\n\n${paragraph(rng)}\n\n${idLine(canary)}\n`, { canary, canaryIn: "content" });
  }
  // A binary file with a Markdown name; the canary is in its name.
  const canary = ctx.canaries.take();
  const blob = Buffer.concat([Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x89]), rng.bytes(2048)]);
  add(`${LOOSE}/binary-${canary}.md`, blob, { canary, canaryIn: "name", note: "binary content with a .md name" });
  for (let i = 0; i < 3; i++) add(`${LOOSE}/config/feature-${i + 1}.json`, `{"enabled": ${rng.bool()}}\n`, { kind: "attachment" });
}

export function documents(rng: Rng, canaries: Canaries, assets: Assets, taken: Set<string>, fixtures: CorpusFile[]): CorpusFile[] {
  homeCursor = 0;
  serviceCursor = 0;
  const ctx: Context = { rng, canaries, assets, files: [], taken, fixtures: new Map(fixtures.map((f) => [f.path, f])), sharedUsers: 0 };
  specialDocuments(ctx);
  workDocuments(ctx); // with the titled image, 40 documents embed the shared logo
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

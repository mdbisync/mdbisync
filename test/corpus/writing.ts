// Hand-written templates for Kitewing's work documents: RFCs, design docs,
// decision records, runbooks, postmortems, API references, guides,
// experiments, launch plans, policies, help articles, onboarding pages,
// FAQs, roadmaps, meeting notes, status updates, on-call handoffs, release
// notes and retrospectives. Every template writes plain GitHub Markdown that
// Linear keeps as it is: no aligned tables, link titles, footnotes or HTML
// with URLs.

import { COMPANY, CUSTOMERS, DEPOTS, PEOPLE, PROFILES, REGIONS, SERVICES, type Kind, type Profile, type Topic } from "./company.ts";
import type { Rng } from "./rng.ts";

/** An image or link the caller placed for the document, already as Markdown. */
export type Media = { markdown: string; kind: "image" | "attachment"; label: string };

export type Draft = {
  /** The H1 heading. */
  heading: string;
  /** Folder below the home folder. */
  folder: string;
  /** File name without ".md". */
  name: string;
  body: string;
};

export type WriteInput = {
  rng: Rng;
  kind: Kind;
  profile: Profile;
  /** The topic for topic kinds; for series, the topics the document mentions are picked from the profile. */
  topic: Topic | null;
  /** Position in a series (week, sprint or release number), or the topic's number. */
  index: number;
  media: Media[];
};

// ---------------------------------------------------------------- helpers

export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The Monday of the given week, counting from the first week of September 2025. */
export function weekDate(week: number, weekday = 0): string {
  const start = Date.UTC(2025, 8, 1); // a Monday
  return new Date(start + (week * 7 + weekday) * 86_400_000).toISOString().slice(0, 10);
}

function people(rng: Rng, n: number): string[] {
  return rng.shuffle(PEOPLE).slice(0, n);
}

function first(name: string): string {
  return name.split(" ")[0] as string;
}

export function amount(n: number, unit: string): string {
  const v = Number.isInteger(n) ? n.toLocaleString("en-US") : String(n);
  if (unit === "") return v;
  if (unit === "%") return `${v}%`;
  if (unit === "EUR") return `EUR ${v}`;
  return `${v} ${unit}`;
}

function midway(topic: Topic, share: number): number {
  const v = topic.before + (topic.after - topic.before) * share;
  return Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
}

export function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function noPeriod(text: string): string {
  return text.replace(/\.$/, "");
}

function table(header: string[], rows: string[][]): string {
  return [header, header.map(() => "---"), ...rows].map((r) => `| ${r.join(" | ")} |`).join("\n");
}

/** Hands out the caller's media in order, as figure paragraphs. */
class Figures {
  #media: Media[];
  constructor(media: Media[]) {
    this.#media = [...media];
  }
  /** The next image as a figure; its caption is its own label, so it always describes the picture. */
  image(): string[] {
    const i = this.#media.findIndex((m) => m.kind === "image");
    if (i < 0) return [];
    const [m] = this.#media.splice(i, 1) as [Media];
    // Tiny status dots sit inline, as they would in a real status line.
    if (m.label.endsWith("status dot")) return [`Status: ${m.markdown} ${m.label.split(" ")[0]}`, ""];
    return [m.markdown, "", `*${m.label}*`, ""];
  }
  /** Whatever is left: images as figures, attachments as a list. */
  rest(): string[] {
    const out: string[] = [];
    while (this.#media.some((m) => m.kind === "image")) out.push(...this.image());
    const files = this.#media.filter((m) => m.kind === "attachment");
    if (files.length > 0) out.push("## Attachments", "", ...files.map((m) => `* ${m.markdown}`), "");
    this.#media = [];
    return out;
  }
}

function service(topic: Topic): string {
  return `\`${topic.system}\``;
}

function flowchart(profile: Profile, rng: Rng): string[] {
  const nodes = profile.labels.map((l, i) => `    ${String.fromCharCode(65 + i)}[${l.charAt(0)}${l.slice(1).toLowerCase()}]`);
  const edges = profile.labels.slice(1).map((_, i) => `    ${String.fromCharCode(65 + i)} --> ${String.fromCharCode(66 + i)}`);
  const extra = rng.bool(0.5) ? [`    ${String.fromCharCode(64 + profile.labels.length)} -. feedback .-> A`] : [];
  return ["```mermaid", `flowchart ${rng.bool() ? "LR" : "TD"}`, ...nodes, ...edges, ...extra, "```"];
}

function sequence(topic: Topic, rng: Rng): string[] {
  const client = rng.pick(["Console", "DriverApp", "Partner"]);
  const svc = topic.system.replace(/[^a-zA-Z]/g, "");
  return [
    "```mermaid",
    "sequenceDiagram",
    `    participant C as ${client}`,
    `    participant S as ${svc}`,
    "    participant D as Database",
    "    C->>S: request",
    "    S->>D: read current state",
    "    D-->>S: rows",
    "    alt change allowed",
    "        S->>D: write in one transaction",
    "        S-->>C: 200 OK",
    "    else conflict",
    "        S-->>C: 409 Conflict",
    "    end",
    "```",
  ];
}

const ROLLOUT = [
  "Ship behind a feature flag, off by default.",
  "Turn it on for the Harbor depot and watch the dashboards for a week.",
  "Extend to all depots in eu-west.",
  "Turn it on everywhere and remove the flag after two quiet weeks.",
];

const ALTERNATIVES: [string, string, string][] = [
  ["Do nothing", "No work, no risk of regressions", "The problem grows with every new depot"],
  ["Buy a hosted tool", "Fast to start, someone else runs it", "Costs per seat and sends our data to a third party"],
  ["Fix it in the client only", "Small change, easy to test", "Every client has to repeat the fix"],
  ["Run a nightly batch job", "Simple and cheap", "Results are up to a day old"],
  ["Add more hardware", "No code change", "Hides the problem until the next growth step"],
];

const QUESTIONS = [
  "Who owns the dashboard after the rollout?",
  "Do partners need advance notice, and how much?",
  "Should the behavior be configurable per depot?",
  "What is the cheapest way to test this before the peak season?",
  "Does support need a new macro for the change?",
  "How do we roll back if the numbers get worse?",
];

// ---------------------------------------------------------------- topic kinds

function rfc(input: WriteInput, topic: Topic, f: Figures): Draft {
  const { rng, index } = input;
  const [author, ...reviewers] = people(rng, 3) as [string, ...string[]];
  const number = String(10 + index * 3 + rng.int(0, 2)).padStart(4, "0");
  const heading = `RFC ${number}: ${topic.title}`;
  const body = [
    `# ${heading}`,
    "",
    `**Author:** ${author} · **Reviewers:** ${reviewers.join(", ")} · **Status:** ${rng.pick(["Draft", "In review", "Accepted"])}`,
    "",
    "## Summary",
    "",
    topic.summary,
    "",
    "## Problem",
    "",
    `${topic.problem} The ${service(topic)} service is where this starts, so that is where we want to fix it.`,
    "",
    "## Background",
    "",
    `The ${topic.metric} has been on the ${input.profile.name.toLowerCase()} dashboard for a year. It sits at ${amount(topic.before, topic.unit)} today, and nothing we tried without changing ${service(topic)} moved it for long. ${rng.pick(["Two earlier attempts fixed the symptom in the client and drifted back within a month.", "Support has tagged the related tickets since spring, so we know how often customers notice.", "The last quarterly review named this as the team's top source of manual work."])}`,
    "",
    "## Proposal",
    "",
    topic.change,
    "",
    ...(rng.bool() ? sequence(topic, rng) : flowchart(input.profile, rng)),
    "",
    ...f.image(),
    "### Detailed design",
    "",
    `The change stays inside ${service(topic)}. Callers see the same API; the new behavior sits behind a flag that the service reads at startup.`,
    "",
    "```ts",
    `export async function handle(request: Request, flags: Flags): Promise<Response> {`,
    `  if (!flags.enabled("${slugify(topic.title)}")) return legacy(request);`,
    "  const current = await store.read(request.key);",
    "  const next = apply(current, request);",
    "  await store.write(request.key, next, { expectedVersion: current.version });",
    "  return ok(next);",
    "}",
    "```",
    "",
    "### Success measure",
    "",
    `We expect the ${topic.metric} to go from ${amount(topic.before, topic.unit)} to about ${amount(topic.after, topic.unit)} within a month of the full rollout.`,
    "",
    "## Rollout",
    "",
    ...ROLLOUT.map((step, i) => `${i + 1}. ${step}`),
    "",
    "## Testing",
    "",
    "* Unit tests for the new path, including the version conflict.",
    "* A replay of one week of production traffic against staging, compared with the old path.",
    `* A load test at three times the peak of the ${rng.pick(DEPOTS)} depot.`,
    "",
    "## Security and privacy",
    "",
    `No new personal data is stored. ${rng.pick(["Access stays behind the existing service token.", "The new cache keys hold ids only, never names or addresses.", "Logs keep the same fields as today; we checked them with the privacy lead."])}`,
    "",
    "## Timeline",
    "",
    table(["Week", "Milestone"], [[weekDate(index * 2 + 30), "Review and sign-off"], [weekDate(index * 2 + 32), "Behind the flag in staging"], [weekDate(index * 2 + 34), "Harbor depot"], [weekDate(index * 2 + 37), "All depots"]]),
    "",
    "## Alternatives considered",
    "",
    table(["Option", "For", "Against"], rng.shuffle(ALTERNATIVES).slice(0, 3)),
    "",
    "## Risks",
    "",
    `${topic.risk} We will watch for this in the first week and keep the flag ready to turn off.`,
    "",
    "## Open questions",
    "",
    ...rng.shuffle(QUESTIONS).slice(0, 3).map((q) => `* [ ] ${q}`),
    "",
  ];
  return { heading, folder: "rfcs", name: `${number}-${slugify(topic.title)}`, body: [...body, ...f.rest()].join("\n") };
}

function design(input: WriteInput, topic: Topic, f: Figures): Draft {
  const { rng, profile } = input;
  const owner = people(rng, 1)[0] as string;
  const heading = `Design: ${topic.title}`;
  const entity = topic.system.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  const body = [
    `# ${heading}`,
    "",
    `Owner: ${owner}. Part of the ${profile.name.toLowerCase()} work for ${rng.pick(["Q1", "Q2", "Q3", "Q4"])} 2026.`,
    "",
    "## Context",
    "",
    topic.problem,
    "",
    "## Goals",
    "",
    `* ${noPeriod(topic.summary)}.`,
    `* Bring the ${topic.metric} to ${amount(topic.after, topic.unit)} or better.`,
    "* Keep the change invisible to people who do not need to know about it.",
    "",
    "## Non-goals",
    "",
    "* Rewriting the service.",
    `* Changing anything for depots outside ${rng.pick(REGIONS)} in the first phase.`,
    "",
    "## Architecture",
    "",
    ...flowchart(profile, rng),
    "",
    topic.change,
    "",
    ...f.image(),
    "## Data model",
    "",
    "```ts",
    `interface ${entity.charAt(0).toUpperCase()}${entity.slice(1)}Record {`,
    "  id: string;",
    "  depotId: string;",
    "  createdAt: Date;",
    `  status: "pending" | "active" | "done";`,
    "  version: number;",
    "}",
    "```",
    "",
    "## Measures",
    "",
    table(["Measure", "Today", "Target"], [
      [topic.metric.charAt(0).toUpperCase() + topic.metric.slice(1), amount(topic.before, topic.unit), amount(topic.after, topic.unit)],
      ["Error rate", "0.4%", "0.4% or lower"],
      ["On-call pages caused", String(rng.int(2, 9)), "0"],
    ]),
    "",
    "## Risks and mitigations",
    "",
    `* **Risk:** ${topic.risk}`,
    `* **Mitigation:** roll out depot by depot and compare the ${topic.metric} with the depots still on the old path.`,
    "",
  ];
  return { heading, folder: "design", name: slugify(topic.title), body: [...body, ...f.rest()].join("\n") };
}

function adr(input: WriteInput, topic: Topic, f: Figures): Draft {
  const { rng, index } = input;
  const number = String(index + 1).padStart(3, "0");
  const decision = noPeriod(topic.change.split(", ")[0] as string);
  const heading = `ADR ${number}: ${topic.title}`;
  const body = [
    `# ${heading}`,
    "",
    `* Status: ${rng.pick(["Accepted", "Accepted", "Proposed", "Superseded by a later decision"])}`,
    `* Date: ${weekDate(rng.int(0, 60), rng.int(0, 4))}`,
    `* Deciders: ${people(rng, 3).join(", ")}`,
    "",
    "## Context",
    "",
    topic.problem,
    "",
    "## Decision",
    "",
    `${decision}.`,
    "",
    topic.change,
    "",
    "## Consequences",
    "",
    `* The ${topic.metric} should drop from ${amount(topic.before, topic.unit)} towards ${amount(topic.after, topic.unit)}.`,
    `* ${topic.risk}`,
    "* The runbook and the dashboards need an update before the rollout.",
    "",
    ...f.rest(),
  ];
  return { heading, folder: "decisions", name: `adr-${number}-${slugify(topic.title)}`, body: body.join("\n") };
}

function runbook(input: WriteInput, topic: Topic, f: Figures): Draft {
  const { rng } = input;
  const region = rng.pick(REGIONS);
  const heading = `Runbook: ${topic.title}`;
  const body = [
    `# ${heading}`,
    "",
    `Use this runbook when the ${service(topic)} alerts fire in any region. ${topic.summary}`,
    "",
    "> [!WARNING]",
    "> Tell the incident channel before you restart anything in production.",
    "",
    "## Symptoms",
    "",
    `* ${topic.problem}`,
    `* The ${topic.metric} on the service dashboard moves away from its usual ${amount(topic.after, topic.unit)}.`,
    "",
    ...f.image(),
    "## Diagnose",
    "",
    "1. Check recent deploys of the service.",
    "",
    "   ```sh",
    `   kw deploys list --service ${topic.system} --region ${region} --since 2h`,
    "   ```",
    "",
    "2. Look at the error log for the last fifteen minutes.",
    "",
    "   ```sh",
    `   kw logs ${topic.system} --region ${region} --level error --since 15m`,
    "   ```",
    "",
    "3. Compare the numbers with the same hour last week on the dashboard.",
    "",
    "## Mitigate",
    "",
    `1. ${topic.change}`,
    `2. If a deploy in the last two hours lines up with the start, roll it back: \`kw deploys rollback ${topic.system} --region ${region}\`.`,
    "3. Post a short update in the incident channel every thirty minutes.",
    "",
    "## Escalate",
    "",
    table(["After", "Who", "How"], [
      ["15 minutes", "Service owner", "Page through the on-call tool"],
      ["30 minutes", "Engineering manager on duty", "Phone"],
      ["Customer impact", "Support lead", "Incident channel"],
    ]),
    "",
    `Last reviewed by ${people(rng, 1)[0]} on ${weekDate(rng.int(30, 60))}.`,
    "",
    ...f.rest(),
  ];
  return { heading, folder: "runbooks", name: slugify(topic.title), body: body.join("\n") };
}

function postmortem(input: WriteInput, topic: Topic, f: Figures): Draft {
  const { rng } = input;
  const date = weekDate(rng.int(0, 60), rng.int(0, 4));
  const start = rng.int(6, 15);
  const minutes = rng.int(25, 140);
  const [lead, ...others] = people(rng, 4) as [string, ...string[]];
  const what = rng.pick([
    `${topic.system} slowed down after a deploy`,
    `${topic.system} returned errors`,
    `${topic.system} stopped processing work`,
    `${topic.system} ran out of connections`,
  ]);
  const heading = `Postmortem: ${what} (${date})`;
  const clock = (offset: number) => {
    const total = start * 60 + offset;
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  };
  const body = [
    `# ${heading}`,
    "",
    `**Incident lead:** ${lead} · **Duration:** ${minutes} minutes · **Severity:** ${rng.pick(["2", "3"])}`,
    "",
    "## Summary",
    "",
    `On ${date} the ${what}. ${topic.problem} This review is blameless: it is about the system, not about people.`,
    "",
    "## Impact",
    "",
    table(["Measure", "Value"], [
      ["Depots affected", rng.pick(["Harbor", "Harbor and Northgate", "all depots in eu-west", "Riverside"])],
      ["Deliveries delayed", String(rng.int(40, 900))],
      ["Support tickets", String(rng.int(5, 120))],
    ]),
    "",
    ...f.image(),
    "## Timeline (UTC)",
    "",
    table(["Time", "Event"], [
      [clock(0), "First alert fires."],
      [clock(rng.int(2, 6)), `${first(others[0] as string)} acknowledges the page.`],
      [clock(rng.int(10, 20)), "Incident declared, channel opened."],
      [clock(Math.floor(minutes * 0.6)), "Mitigation applied."],
      [clock(minutes), "Numbers back to normal; incident closed."],
    ]),
    "",
    "## Root cause",
    "",
    `${topic.risk.replace(/ could | would | may /, " did ")} Nothing in our checks caught it before customers did.`,
    "",
    "## What went well",
    "",
    "* The alert fired within two minutes.",
    "* The runbook covered the first steps.",
    "",
    "## What did not go well",
    "",
    "* It took a while to find who owned the affected part.",
    "* Status updates to support were late.",
    "",
    "## Action items",
    "",
    `* [ ] ${first(others[1] as string)}: ${topic.change}`,
    `* [ ] ${first(others[2] as string)}: add an alert on the ${topic.metric}.`,
    `* [x] ${first(lead)}: update the runbook with what we learned.`,
    "",
    ...f.rest(),
  ];
  return { heading, folder: "postmortems", name: `${date}-${slugify(what)}`, body: body.join("\n") };
}

function api(input: WriteInput, topic: Topic, f: Figures): Draft {
  const { rng } = input;
  const resource = rng.pick(["orders", "routes", "stops", "events", "invoices", "partners"]);
  const heading = `API reference: ${topic.title}`;
  const body = [
    `# ${heading}`,
    "",
    `${topic.summary} All endpoints belong to ${service(topic)} and need a bearer token.`,
    "",
    "## Endpoints",
    "",
    table(["Method", "Path", "What it does"], [
      ["`GET`", `\`/v2/${resource}\``, "List, newest first, 50 per page"],
      ["`GET`", `\`/v2/${resource}/{id}\``, "Read one"],
      ["`POST`", `\`/v2/${resource}\``, "Create; send an `Idempotency-Key` header"],
      ["`PATCH`", `\`/v2/${resource}/{id}\``, "Change some fields"],
    ]),
    "",
    "## Example",
    "",
    "```http",
    `POST /v2/${resource} HTTP/1.1`,
    "Host: api.kitewing.example",
    "Authorization: Bearer <token>",
    "Idempotency-Key: 6f1c2d4e-0b7a-4d1f-9a55-3c2e8f7b1a90",
    "Content-Type: application/json",
    "```",
    "",
    "```json",
    JSON.stringify({ depot: rng.pick(DEPOTS).toLowerCase().replace(" ", "-"), customer: rng.pick(CUSTOMERS), parcels: rng.int(1, 6), window: { from: "09:00", to: "11:00" } }, null, 2),
    "```",
    "",
    "## Errors",
    "",
    table(["Status", "Code", "Meaning"], [
      ["400", "`invalid_request`", "A field is missing or has the wrong type"],
      ["401", "`unauthorized`", "The token is missing or expired"],
      ["409", "`conflict`", "Someone changed the record since you read it"],
      ["429", "`rate_limited`", "Wait for the time in `Retry-After`"],
    ]),
    "",
    ...f.rest(),
  ];
  return { heading, folder: "api", name: slugify(topic.title), body: body.join("\n") };
}

function howto(input: WriteInput, topic: Topic, f: Figures): Draft {
  const { rng } = input;
  const heading = `How to: ${lower(topic.title)}`;
  const body = [
    `# ${heading}`,
    "",
    `${topic.summary} This guide takes about ${rng.int(3, 15)} minutes.`,
    "",
    "## Before you start",
    "",
    "* You need access to the console with your work account.",
    `* Ask ${people(rng, 1)[0]} if you are not sure which depot you belong to.`,
    "",
    "## Steps",
    "",
    "1. Open the console and choose your depot in the top bar.",
    `2. ${topic.change}`,
    "3. Check the result on the overview page.",
    "",
    ...f.image(),
    "> [!TIP]",
    `> ${topic.risk} If that happens, undo the last step and ask in the team channel.`,
    "",
    "## Related",
    "",
    `* ${topic.problem}`,
    "",
    ...f.rest(),
  ];
  return { heading, folder: "guides", name: slugify(`how to ${topic.title}`), body: body.join("\n") };
}

function experiment(input: WriteInput, topic: Topic, f: Figures): Draft {
  const { rng } = input;
  const users = rng.int(2, 12) * 1000;
  const heading = `Experiment: ${topic.title}`;
  const body = [
    `# ${heading}`,
    "",
    "## Hypothesis",
    "",
    `If we ${lower(noPeriod(topic.change))}, the ${topic.metric} will fall from ${amount(topic.before, topic.unit)} to below ${amount(midway(topic, 0.7), topic.unit)}.`,
    "",
    "## Setup",
    "",
    `* ${users.toLocaleString("en-US")} sessions per variant over two weeks.`,
    "* Planners and support agents, split by account.",
    "* Primary measure decided before the start; no peeking before day 14.",
    "",
    "## Results",
    "",
    table(["Variant", topic.metric.charAt(0).toUpperCase() + topic.metric.slice(1), "Sessions"], [
      ["Control", amount(topic.before, topic.unit), users.toLocaleString("en-US")],
      ["New", amount(midway(topic, rng.int(55, 95) / 100), topic.unit), (users + rng.int(-200, 200)).toLocaleString("en-US")],
    ]),
    "",
    ...f.image(),
    "## Decision",
    "",
    `${rng.pick(["Ship to everyone.", "Ship, then tune the ranking weights.", "Run one more week with a larger sample."])} ${topic.risk}`,
    "",
    ...f.rest(),
  ];
  return { heading, folder: "experiments", name: slugify(topic.title), body: body.join("\n") };
}

function launch(input: WriteInput, topic: Topic, f: Figures): Draft {
  const { rng } = input;
  const [pm, eng, support] = people(rng, 3) as [string, string, string];
  const week = rng.int(20, 60);
  const heading = `Launch plan: ${topic.title}`;
  const body = [
    `# ${heading}`,
    "",
    `${topic.summary} Launch date: **${weekDate(week, 1)}**.`,
    "",
    "## Why",
    "",
    `${topic.problem} We expect the ${topic.metric} to go from ${amount(topic.before, topic.unit)} to ${amount(topic.after, topic.unit)}.`,
    "",
    "## Owners",
    "",
    table(["Area", "Owner"], [["Product", pm], ["Engineering", eng], ["Support and docs", support]]),
    "",
    "## Checklist",
    "",
    "### Two weeks before",
    "",
    "* [x] Feature flag in place and tested in staging",
    "* [x] Beta with three friendly customers",
    "* [ ] Help center article drafted",
    "",
    "### Launch week",
    "",
    "* [ ] Turn the flag on for 10 percent of accounts",
    "* [ ] Send the announcement email",
    "* [ ] Brief support on the new questions they will get",
    "",
    "### After launch",
    "",
    "* [ ] Watch the dashboards daily for a week",
    "* [ ] Write the launch retrospective",
    "",
    ...f.image(),
    "## Risks",
    "",
    topic.risk,
    "",
    ...f.rest(),
  ];
  return { heading, folder: "plans", name: slugify(topic.title), body: body.join("\n") };
}

function policy(input: WriteInput, topic: Topic, f: Figures): Draft {
  const { rng } = input;
  const heading = topic.title;
  const body = [
    `# ${heading}`,
    "",
    `**In short:** ${topic.summary}`,
    "",
    "## Why we have this policy",
    "",
    topic.problem,
    "",
    "## What it means for you",
    "",
    topic.change,
    "",
    "* Talk to your manager if the policy does not fit your situation.",
    `* Questions go to the ${rng.pick(["people", "operations", "finance"])} team channel.`,
    "",
    ...f.image(),
    "## Exceptions",
    "",
    topic.risk,
    "",
    "<details>",
    "<summary>How this policy changes</summary>",
    "",
    `We review it once a year. The last review was on ${weekDate(rng.int(10, 50))}, led by ${people(rng, 1)[0]}.`,
    "",
    "</details>",
    "",
    ...f.rest(),
  ];
  return { heading, folder: "policies", name: slugify(topic.title), body: body.join("\n") };
}

function article(input: WriteInput, topic: Topic, f: Figures): Draft {
  const heading = topic.title;
  const body = [
    `# ${heading}`,
    "",
    topic.summary,
    "",
    "## How it works",
    "",
    topic.change,
    "",
    ...f.image(),
    "> [!NOTE]",
    `> ${topic.risk}`,
    "",
    "## Still need help?",
    "",
    "Write to support@kitewing.example with your parcel or account number. We answer within one working day.",
    "",
    ...f.rest(),
  ];
  return { heading, folder: "articles", name: slugify(topic.title), body: body.join("\n") };
}

function onboarding(input: WriteInput, topic: Topic, f: Figures): Draft {
  const { rng, profile } = input;
  const buddy = people(rng, 1)[0] as string;
  const heading = `Getting started: ${lower(topic.title)}`;
  const body = [
    `# ${heading}`,
    "",
    `Welcome! This page is for people new to the ${profile.name.toLowerCase()}. Your buddy for the first weeks is ${buddy}.`,
    "",
    "## Your first week",
    "",
    "* [ ] Meet your manager and your buddy",
    "* [ ] Set up the password manager and two-factor login",
    `* [ ] Read the page on ${lower(topic.title)}`,
    "* [ ] Spend half a day with a driver on a route",
    "",
    "## What to know",
    "",
    topic.summary,
    "",
    topic.change,
    "",
    ...f.image(),
    "## People to meet",
    "",
    table(["Who", "Why"], people(rng, 3).map((p, i) => [p, ["Knows the history of most decisions", "Runs the weekly planning", "Answers questions about tools"][i] as string])),
    "",
    ...f.rest(),
  ];
  return { heading, folder: "onboarding", name: slugify(topic.title), body: body.join("\n") };
}

function faq(input: WriteInput, topic: Topic, f: Figures): Draft {
  const heading = `${topic.title}: questions and answers`;
  const qa: [string, string][] = [
    ["What is changing?", topic.summary],
    ["Why?", topic.problem],
    ["What do I need to do?", topic.change],
    ["Is there anything to watch out for?", topic.risk],
  ];
  const body = [
    `# ${heading}`,
    "",
    ...qa.flatMap(([q, a], i) => (i % 2 === 0 ? [`### ${q}`, "", a, ""] : ["<details>", `<summary>${q}</summary>`, "", a, "", "</details>", ""])),
    ...f.rest(),
  ];
  return { heading, folder: "faq", name: slugify(topic.title), body: body.join("\n") };
}

function roadmap(input: WriteInput, topic: Topic, f: Figures): Draft {
  const { rng, profile } = input;
  const heading = `Roadmap: ${topic.title}`;
  const start = rng.int(18, 40);
  const body = [
    `# ${heading}`,
    "",
    topic.summary,
    "",
    "```mermaid",
    "gantt",
    `    title ${topic.title}`,
    "    dateFormat YYYY-MM-DD",
    "    section Build",
    `    Design review      :a1, ${weekDate(start)}, 7d`,
    "    First version      :a2, after a1, 21d",
    "    section Rollout",
    "    One depot          :b1, after a2, 7d",
    "    All depots         :b2, after b1, 14d",
    "```",
    "",
    "## Milestones",
    "",
    table(["Milestone", "Target date", "Status"], [
      ["Design approved", weekDate(start + 1), "✅ Done"],
      ["First version in staging", weekDate(start + 4), "🟡 In progress"],
      ["All depots", weekDate(start + 7), "⚪ Not started"],
    ]),
    "",
    ...f.image(),
    `The ${profile.name.toLowerCase()} team reviews this roadmap every two weeks.`,
    "",
    ...f.rest(),
  ];
  return { heading, folder: "roadmap", name: slugify(topic.title), body: body.join("\n") };
}

// ---------------------------------------------------------------- series

/** Where a topic stands in a dated series: early weeks plan, late weeks ship. */
function progress(topic: Topic, rng: Rng, index: number): string {
  const stages = [
    `${topic.title}: design review scheduled for ${rng.pick(["Tuesday", "Wednesday", "Thursday"])}.`,
    `${topic.title}: design review done, building the first version.`,
    `${topic.title}: first version in staging, waiting for a review from ${first(rng.pick(PEOPLE))}.`,
    `${topic.title}: rollout reached ${rng.int(2, 6)} depots; the ${topic.metric} is at ${amount(midway(topic, 0.5), topic.unit)}, down from ${amount(topic.before, topic.unit)}.`,
    `${topic.title}: on at every depot; the ${topic.metric} is ${amount(midway(topic, 0.85), topic.unit)}.`,
    `${topic.title}: done, and the flag is removed 🎉`,
  ];
  if (rng.bool(0.08)) return `${topic.title}: paused for a week while we handle the peak at ${rng.pick(DEPOTS)}.`;
  const stage = Math.max(0, Math.min(stages.length - 1, Math.floor(index / 9) + rng.int(-1, 1)));
  return stages[stage] as string;
}

function seriesTopics(input: WriteInput, n: number): Topic[] {
  const pool = input.profile.topics.length > 0 ? input.profile.topics : [];
  return input.rng.shuffle(pool).slice(0, n);
}

function meeting(input: WriteInput, f: Figures): Draft {
  const { rng, profile, index } = input;
  const date = weekDate(index, rng.int(0, 3));
  const attendees = people(rng, rng.int(3, 6));
  const topics = seriesTopics(input, rng.int(2, 3));
  const kind = rng.pick(["Weekly sync", "Planning", "Architecture review", "Team meeting"]);
  const heading = `${profile.name} ${lower(kind)}, ${date}`;
  const body = [
    `# ${heading}`,
    "",
    `**Attendees:** ${attendees.join(", ")}`,
    "",
    "## Agenda",
    "",
    ...topics.map((tp, i) => `${i + 1}. ${tp.title}`),
    `${topics.length + 1}. Anything else`,
    "",
    "## Notes",
    "",
    ...topics.flatMap((tp) => [`### ${tp.title}`, "", `${first(rng.pick(attendees))} summarized where we are. ${progress(tp, rng, index)}`, "", `* ${tp.risk}`, `* Agreed to keep an eye on the ${tp.metric}.`, ""]),
    ...f.image(),
    "## Decisions",
    "",
    `* ${topics[0] ? noPeriod(topics[0].change.split(", ")[0] as string) : "Keep the current plan"}.`,
    "",
    "## Action items",
    "",
    ...topics.map((tp) => `* [ ] ${first(rng.pick(attendees))}: follow up on ${lower(tp.title)} by ${weekDate(index + 1, 4)}`),
    `* [x] ${first(rng.pick(attendees))}: share these notes in the team channel`,
    "",
    ...f.rest(),
  ];
  return { heading, folder: `meetings/${date.slice(0, 4)}`, name: `${date}-${slugify(kind)}`, body: body.join("\n") };
}

function status(input: WriteInput, f: Figures): Draft {
  const { rng, profile, index } = input;
  const date = weekDate(index, 4);
  const topics = seriesTopics(input, 3);
  const mood = rng.pick(["🟢 On track", "🟢 On track", "🟡 Some risk", "🔴 Off track"]);
  const heading = `${profile.name} status, week of ${weekDate(index)}`;
  const body = [
    `# ${heading}`,
    "",
    `**Overall:** ${mood}`,
    "",
    "## Highlights",
    "",
    ...topics.map((tp) => `* ${progress(tp, rng, index)}`),
    "",
    "## Numbers",
    "",
    table(["Measure", "Last week", "This week", "Trend"], topics.map((tp) => {
      const a = midway(tp, rng.int(20, 60) / 100);
      const b = midway(tp, rng.int(40, 90) / 100);
      return [tp.metric.charAt(0).toUpperCase() + tp.metric.slice(1), amount(a, tp.unit), amount(b, tp.unit), (b < a) === (tp.after < tp.before) ? "📈 better" : "📉 worse"];
    })),
    "",
    ...f.image(),
    "## Risks",
    "",
    ...topics.slice(0, 1).map((tp) => `* ${tp.risk}`),
    "",
    "## Next week",
    "",
    ...topics.map((tp) => `* ${noPeriod(tp.change.split(", ")[0] as string)}.`),
    "",
    `Posted by ${people(rng, 1)[0]} on ${date}.`,
    "",
    ...f.rest(),
  ];
  return { heading, folder: "status", name: `${weekDate(index)}-status`, body: body.join("\n") };
}

function handoff(input: WriteInput, f: Figures): Draft {
  const { rng, index } = input;
  const [from, to] = people(rng, 2) as [string, string];
  const topics = seriesTopics(input, 2);
  const pages = rng.int(2, 6);
  const heading = `On-call handoff, week of ${weekDate(index)}`;
  const body = [
    `# ${heading}`,
    "",
    `From **${from}** to **${to}**. ${pages} pages this week, ${rng.int(0, pages)} of them at night.`,
    "",
    "## Pages",
    "",
    table(["When", "Alert", "What we did"], Array.from({ length: pages }, () => {
      return [`${weekDate(index, rng.int(0, 6))} ${String(rng.int(0, 23)).padStart(2, "0")}:${String(rng.int(0, 59)).padStart(2, "0")}`, `${rng.pick(SERVICES)} ${rng.pick(["high latency", "error rate", "queue depth", "health check"])}`, rng.pick(["Followed the runbook, resolved", "Rolled back the last deploy", "False alarm, threshold tuned", "Escalated to the service owner"])];
    })),
    "",
    "## Still open",
    "",
    ...topics.map((tp) => `* [ ] ${tp.title}. ${tp.problem}`),
    "",
    ...f.image(),
    "## Notes for the next shift",
    "",
    `* The ${rng.pick(DEPOTS)} depot starts an hour early on ${weekDate(index + 1, rng.int(0, 4))}.`,
    `* ${topics[0]?.risk ?? "Nothing else to watch."}`,
    "",
    ...f.rest(),
  ];
  return { heading, folder: `handoffs/${weekDate(index).slice(0, 4)}`, name: `${weekDate(index)}-handoff`, body: body.join("\n") };
}

const NEW = [
  "Planners can now pin a route to the top of the board.",
  "The tracking page shows the driver's first name and a photo, if the driver agreed.",
  "Partners can download a month of delivery events as one file.",
  "Routes can include a lunch break at a fixed time.",
  "The driver app reads the next address aloud when the phone is in the car holder.",
  "Customers can choose a safe place for parcels when they are not home.",
  "Depot managers get a short summary of the day by email at 18:00.",
  "Search finds orders by the customer's phone number.",
];
const IMPROVED = [
  "The dispatch board loads twice as fast for large depots.",
  "Arrival windows are more accurate in the old town in the morning.",
  "Error messages in the partner API say which field was wrong.",
  "Scanning works better in low light.",
  "Invoices list the depot for every delivery.",
  "The route map uses clearer colors for finished stops.",
];
const FIXED = [
  "Stops with a long note no longer overlap the next stop on the board.",
  "The tracking link in reminder messages opened the wrong language.",
  "Weekly reports counted deliveries after midnight on the wrong day.",
  "Drivers could not mark a stop as failed without signal.",
  "Some partners saw a 500 error when an order had no phone number.",
  "Exported CSV files broke when a note contained a comma.",
  "The planner forgot the selected depot after a page refresh.",
];

function release(input: WriteInput, f: Figures): Draft {
  const { rng, profile, index } = input;
  const mobile = profile.name === "Driver app";
  const support = profile.name === "Help center";
  const version = mobile ? `3.${index}` : support ? `4.${index}` : `4.${index}.${rng.int(0, 2)}`;
  const date = weekDate(index * 2 + rng.int(0, 1), 2);
  const product = mobile ? "Driver app" : "Kitewing";
  const heading = support ? `What's new in ${product} ${version}` : `${product} ${version}`;
  const body = [
    `# ${heading}`,
    "",
    `Released on ${date}. ${rng.pick(["A small release with mostly fixes.", "This release focuses on speed.", "A big one: thanks to everyone who sent feedback.", "Mostly improvements for planners."])}`,
    "",
    ...f.image(),
    "## New",
    "",
    ...rng.shuffle(NEW).slice(0, rng.int(1, 3)).map((s) => `* ${s}`),
    "",
    "## Improved",
    "",
    ...rng.shuffle(IMPROVED).slice(0, rng.int(1, 3)).map((s) => `* ${s}`),
    "",
    "## Fixed",
    "",
    ...rng.shuffle(FIXED).slice(0, rng.int(1, 4)).map((s) => `* ${s}`),
    "",
    ...f.rest(),
  ];
  return { heading, folder: support ? "announcements" : `releases/${date.slice(0, 4)}`, name: slugify(`${product} ${version}`), body: body.join("\n") };
}

function retro(input: WriteInput, f: Figures): Draft {
  const { rng, profile, index } = input;
  const topics = seriesTopics(input, 2);
  const heading = `${profile.name} retrospective, sprint ${index + 1}`;
  const body = [
    `# ${heading}`,
    "",
    `Sprint ended on ${weekDate(index * 2 + 1, 4)}. Facilitator: ${people(rng, 1)[0]}.`,
    "",
    "## What went well 👍",
    "",
    ...topics.map((tp) => `* ${progress(tp, rng, index)}`),
    `* ${rng.pick(["Pairing on the tricky parts saved time.", "The demo went smoothly.", "Reviews were quick this sprint.", "Nobody was paged at night."])}`,
    "",
    "## What could be better 🤔",
    "",
    ...topics.slice(0, 1).map((tp) => `* ${tp.risk}`),
    `* ${rng.pick(["Too many meetings on Wednesday.", "Tickets were unclear at the start.", "We found a bug late, in staging.", "The flaky test failed six times."])}`,
    "",
    ...f.image(),
    "## Actions",
    "",
    ...topics.map((tp) => `* [ ] ${first(rng.pick(PEOPLE))}: ${lower(noPeriod(tp.change.split(", ")[0] as string))}`),
    "",
    ...f.rest(),
  ];
  return { heading, folder: "retros", name: `sprint-${index + 1}`, body: body.join("\n") };
}

function spec(input: WriteInput, topic: Topic, f: Figures): Draft {
  const { rng, profile } = input;
  const [pm, designer, eng] = people(rng, 3) as [string, string, string];
  const heading = `Product spec: ${topic.title}`;
  const body = [
    `# ${heading}`,
    "",
    table(["Role", "Name"], [["Product", pm], ["Design", designer], ["Engineering", eng]]),
    "",
    "## Problem",
    "",
    topic.problem,
    "",
    "## Who it is for",
    "",
    `* **Planners** at busy depots, who ${rng.pick(["work against the clock every morning", "handle most of the changes during the day", "answer to customers when things go wrong"])}.`,
    `* **Drivers**, who see the result on the road.`,
    `* **Support**, who explain it to customers of the ${profile.name.toLowerCase()}.`,
    "",
    "## User stories",
    "",
    `1. As a planner, I want the team to ${lower(noPeriod(topic.summary))}, so that the day starts on time.`,
    `2. As a driver, I want the change to need no extra taps.`,
    `3. As a support agent, I want to see when it happened, so that I can answer customers.`,
    "",
    "## Requirements",
    "",
    table(["Requirement", "Priority"], [
      [noPeriod(topic.change.split(", ")[0] as string), "Must"],
      [`Show the ${topic.metric} on the dashboard`, "Must"],
      ["Work at every depot without extra setup", "Should"],
      ["Let each depot switch it off", "Could"],
    ]),
    "",
    ...f.image(),
    "## Acceptance criteria",
    "",
    `* [ ] The ${topic.metric} reaches ${amount(topic.after, topic.unit)} at the pilot depot.`,
    "* [ ] No new support ticket type in the first two weeks.",
    "* [ ] The help center article is published on launch day.",
    "",
    "## Out of scope",
    "",
    `* ${topic.risk.replace(/ could | would | may /, " will not be solved here: it ")}`,
    "",
    ...f.rest(),
  ];
  return { heading, folder: "specs", name: slugify(topic.title), body: body.join("\n") };
}

function callnotes(input: WriteInput, f: Figures): Draft {
  const { rng, index } = input;
  const customer = rng.pick(CUSTOMERS);
  const date = weekDate(index, rng.int(0, 4));
  const [agent, ...others] = people(rng, 2) as [string, ...string[]];
  const topics = seriesTopics(input, 2);
  const heading = `Call with ${customer}, ${date}`;
  const body = [
    `# ${heading}`,
    "",
    `**From ${COMPANY}:** ${agent}, ${others.join(", ")} · **Customer:** the operations lead at ${customer} · **Length:** ${rng.int(15, 50)} minutes`,
    "",
    "## Why we talked",
    "",
    `${customer} ${rng.pick(["asked for a call after a late delivery last week.", "is renewing their contract next month.", "wanted to hear what is coming in the next release.", "reported a problem with their tracking links."])}`,
    "",
    "## What they said",
    "",
    ...topics.map((tp) => `> ${tp.problem}`).flatMap((q) => [q, ""]),
    "## What we said",
    "",
    ...topics.map((tp) => `* ${tp.title}: ${lower(tp.summary)}`),
    "",
    ...f.image(),
    "## Follow-ups",
    "",
    `* [ ] ${first(agent)}: send the release notes link by ${weekDate(index, 4)}`,
    `* [ ] ${first(others[0] as string)}: check their last ${rng.int(20, 200)} deliveries for late stops`,
    "* [x] Log the call in the customer record",
    "",
    ...f.rest(),
  ];
  return { heading, folder: `calls/${date.slice(0, 4)}`, name: `${date}-${slugify(customer)}`, body: body.join("\n") };
}

function okr(input: WriteInput, f: Figures): Draft {
  const { rng, profile, index } = input;
  const year = 2025 + Math.floor((index + 2) / 4);
  const quarter = ((index + 2) % 4) + 1;
  const topics = seriesTopics(input, 3);
  const heading = `${profile.name} goals, Q${quarter} ${year}`;
  const body = [
    `# ${heading}`,
    "",
    `What the ${profile.name.toLowerCase()} team commits to this quarter. We score each key result from 0 to 1 at the end of the quarter; 0.7 is a good result.`,
    "",
    ...topics.flatMap((tp, i) => {
      const score = (rng.int(2, 10) / 10).toFixed(1);
      return [
        `## Objective ${i + 1}: ${tp.title.toLowerCase()}`,
        "",
        tp.summary,
        "",
        table(["Key result", "Target", "Score"], [
          [`${tp.metric.charAt(0).toUpperCase()}${tp.metric.slice(1)}`, amount(tp.after, tp.unit), score],
          ["Rolled out to every depot", "100%", (rng.int(3, 10) / 10).toFixed(1)],
        ]),
        "",
      ];
    }),
    ...f.image(),
    "## Not this quarter",
    "",
    `* ${rng.pick(["A new reporting tool", "Moving to a new cloud region", "A redesign of the settings pages", "Rewriting the importer"])}: worth doing, but not now.`,
    "",
    ...f.rest(),
  ];
  return { heading, folder: "goals", name: `${year}-q${quarter}`, body: body.join("\n") };
}

function newsletter(input: WriteInput, f: Figures): Draft {
  const { rng, index } = input;
  const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][(index + 8) % 12] as string;
  const year = 2025 + Math.floor((index + 8) / 12);
  const pick = rng.shuffle(Object.values(PROFILES).flatMap((p) => p.topics)).slice(0, 3);
  const joiners = people(rng, 2);
  const heading = `${COMPANY} monthly, ${month} ${year}`;
  const body = [
    `# ${heading}`,
    "",
    `Hello everyone! Here is what happened at ${COMPANY} in ${month}.`,
    "",
    "## Highlights",
    "",
    ...pick.map((tp) => `* **${tp.title}.** ${tp.summary}`),
    "",
    ...f.image(),
    "## Welcome",
    "",
    `Please say hello to ${joiners.join(" and ")}, who joined us this month.`,
    "",
    "## Numbers",
    "",
    table(["", "This month", "Last month"], [
      ["Deliveries planned", (rng.int(180, 260) * 1000).toLocaleString("en-US"), (rng.int(170, 250) * 1000).toLocaleString("en-US")],
      ["Depots live", String(rng.int(30, 60)), String(rng.int(28, 58))],
      ["Customer satisfaction", `${rng.int(85, 96)}%`, `${rng.int(84, 95)}%`],
    ]),
    "",
    "## Coming up",
    "",
    `* Team day on ${weekDate(index * 4 + 3, 4)}, with lunch at the Harbor depot.`,
    "* The next all-hands is on the first Monday of the month.",
    "",
    ...f.rest(),
  ];
  return { heading, folder: "newsletter", name: `${year}-${String(((index + 8) % 12) + 1).padStart(2, "0")}-${month.toLowerCase()}`, body: body.join("\n") };
}

function apichangelog(input: WriteInput, f: Figures): Draft {
  const { rng, index } = input;
  const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][(index + 6) % 12] as string;
  const year = 2025 + Math.floor((index + 6) / 12);
  const resource = rng.pick(["orders", "routes", "stops", "events", "invoices"]);
  const heading = `API changelog, ${month} ${year}`;
  const body = [
    `# ${heading}`,
    "",
    "Changes to the data API this month. Nothing here breaks existing clients unless it says **Breaking**.",
    "",
    "## Added",
    "",
    `* \`GET /v2/${resource}\` accepts \`updatedSince\`, so exports can fetch only what changed.`,
    `* The \`${resource}\` table has a new \`depot_region\` column.`,
    "",
    "## Changed",
    "",
    `* Exports of more than ${rng.int(5, 50) * 1000} rows are split into pages of 10,000.`,
    "",
    ...(index % 3 === 2 ? ["## Breaking", "", `* The old \`/v1/${resource}\` endpoint stops on ${weekDate(index * 4 + 20)}. Move to \`/v2\` before then.`, ""] : []),
    "## Example",
    "",
    "```sh",
    `curl -H "Authorization: Bearer $TOKEN" "https://api.kitewing.example/v2/${resource}?updatedSince=${weekDate(index * 4)}"`,
    "```",
    "",
    ...f.rest(),
  ];
  return { heading, folder: "changelog", name: `${year}-${String(((index + 6) % 12) + 1).padStart(2, "0")}`, body: body.join("\n") };
}

export function writeDocument(input: WriteInput): Draft {
  const f = new Figures(input.media);
  const { kind, topic } = input;
  const needTopic = (): Topic => {
    if (!topic) throw new Error(`${kind} needs a topic`);
    return topic;
  };
  let draft: Draft;
  switch (kind) {
    case "rfc": draft = rfc(input, needTopic(), f); break;
    case "design": draft = design(input, needTopic(), f); break;
    case "adr": draft = adr(input, needTopic(), f); break;
    case "runbook": draft = runbook(input, needTopic(), f); break;
    case "postmortem": draft = postmortem(input, needTopic(), f); break;
    case "api": draft = api(input, needTopic(), f); break;
    case "howto": draft = howto(input, needTopic(), f); break;
    case "experiment": draft = experiment(input, needTopic(), f); break;
    case "launch": draft = launch(input, needTopic(), f); break;
    case "policy": draft = policy(input, needTopic(), f); break;
    case "article": draft = article(input, needTopic(), f); break;
    case "onboarding": draft = onboarding(input, needTopic(), f); break;
    case "faq": draft = faq(input, needTopic(), f); break;
    case "roadmap": draft = roadmap(input, needTopic(), f); break;
    case "meeting": draft = meeting(input, f); break;
    case "status": draft = status(input, f); break;
    case "handoff": draft = handoff(input, f); break;
    case "release": draft = release(input, f); break;
    case "retro": draft = retro(input, f); break;
    case "spec": draft = spec(input, needTopic(), f); break;
    case "callnotes": draft = callnotes(input, f); break;
    case "okr": draft = okr(input, f); break;
    case "newsletter": draft = newsletter(input, f); break;
    case "apichangelog": draft = apichangelog(input, f); break;
  }
  return { ...draft, body: draft.body.replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n") };
}

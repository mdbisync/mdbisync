// The corpus tree: team and project folders with their annotations, the
// folders where generated files live, and the files at the corpus root.
//
// The tidy part reads like one company's documentation. Everything that
// exists to exercise an edge case (sizes, odd names, lint errors, marker
// lookalikes, unusual typography) lives under eng/edge-cases/, so a reader
// can open the tidy part first.

import { validateSha } from "../../src/release/package.ts";
import { COMPANY, PROFILE_PATHS, PROFILES } from "./company.ts";
import { gitattributes, idLine, markdownFile, relativeLink, type Canaries, type CorpusFile } from "./model.ts";
import type { Rng } from "./rng.ts";

/** A folder that holds synchronized documents. */
export type Home = {
  /** Folder path relative to the corpus root. */
  path: string;
  /** "team" for a team zone folder, "project" for a project folder. */
  scope: "team" | "project";
  team: "ENG" | "DOCS";
};

export const ENG_PROJECTS = [
  { folder: "eng/platform", placeholder: "PROJECT_ENG_1" },
  { folder: "eng/mobile app", placeholder: "PROJECT_ENG_2" },
  { folder: "eng/data.pipeline", placeholder: "PROJECT_ENG_3" },
  { folder: "eng/search (beta)", placeholder: "PROJECT_ENG_4" },
  // Large areas are projects so that no container in Linear grows past its document cap.
  { folder: "eng/edge-cases", placeholder: "PROJECT_ENG_5" },
  { folder: "eng/localization", placeholder: "PROJECT_ENG_6" },
];
export const DOCS_PROJECTS = [
  { folder: "docs/handbook", placeholder: "PROJECT_DOCS_1" },
  { folder: "docs/release notes", placeholder: "PROJECT_DOCS_2" },
  { folder: "docs/reference", placeholder: "PROJECT_DOCS_3" },
];
/** A folder with a team and a project annotation together, and no team zone. */
export const COMBINED = { folder: "support", placeholder: "PROJECT_COMBINED", team: "DOCS" as const };

/** The fixture bank is copied here, keeping its own folder layout. */
export const BANK_HOME = "docs/reference";
/** Files above every annotation. */
export const LOOSE = "workspace";
/** The project for edge cases. */
export const EDGE = "eng/edge-cases";
/** Edge cases whose titles depend on the team zone: long titles and duplicate titles. */
export const EDGE_ZONE = "eng/edge-cases (team zone)";
/** Team-zone folder for the duplicate-title pairs. */
export const COLLISIONS = `${EDGE_ZONE}/collisions`;
/** The project with documents in other languages and scripts. */
export const LOCALIZATION = "eng/localization";

const PROJECT_FOLDERS = new Set([...ENG_PROJECTS, ...DOCS_PROJECTS].map((p) => p.folder));

/** Where generated work documents live: one home per company area or project. */
export const HOMES: Home[] = PROFILE_PATHS.map((path): Home => ({
  path,
  scope: PROJECT_FOLDERS.has(path) || path === COMBINED.folder ? "project" : "team",
  team: path.startsWith("eng/") ? "ENG" : "DOCS",
}));

function annotated(path: string, frontMatter: string[], body: string, canary: string): CorpusFile {
  const front = frontMatter.length > 0 ? `---\n${frontMatter.join("\n")}\n---\n\n` : "";
  return markdownFile({ path, content: Buffer.from(`${front}${body}\n${idLine(canary)}\n`), group: "annotations", canary, canaryIn: "content" });
}

function areaTable(prefix: string): string {
  const rows = PROFILE_PATHS.filter((p) => p.startsWith(prefix)).map((p) => `| ${p.slice(prefix.length)} | ${PROFILES[p]?.about} |`);
  return ["| Folder | What is in it |", "| --- | --- |", ...rows].join("\n");
}

function teamReadme(team: "eng" | "docs"): string {
  if (team === "eng") {
    return [
      "# Engineering",
      "",
      `This is where ${COMPANY} engineering writes things down: design docs and RFCs before we build, runbooks and postmortems for when things break, and notes from our meetings.`,
      "",
      "## Areas and projects",
      "",
      areaTable("eng/"),
      `| localization | Translations, glossaries and style notes for every language the driver app speaks. |`,
      "| edge-cases | Formatting samples and unusual files: large documents, odd file names and constructs that do not render everywhere. |",
      "| edge-cases (team zone) | Edge cases about titles in the team zone: very long titles and names that collide. |",
      "",
      "## How we write",
      "",
      "* Write the RFC before the code, and keep it short enough to read over a coffee.",
      "* Every runbook names an owner and the date it was last checked.",
      "* Postmortems are blameless and end with action items that have owners.",
      "",
    ].join("\n");
  }
  return [
    "# Documentation",
    "",
    `The documentation team keeps the company handbook, the release notes and the reference pages, and runs the help center for ${COMPANY} customers.`,
    "",
    areaTable("docs/"),
    "| reference | A reference of every Markdown construct we use, one small page each. |",
    "",
  ].join("\n");
}

function projectReadme(folder: string): string {
  const profile = PROFILES[folder];
  if (folder === BANK_HOME) {
    return "# Markdown reference\n\nOne small page per Markdown construct: headings, lists, tables, code, links, images and more. Use it to check how a construct looks before you use it in a real document.\n";
  }
  if (folder === EDGE) {
    return "# Edge cases\n\nFormatting samples and unusual files: large documents, odd file names, construct combinations, lint errors and constructs that do not render everywhere. They live here, away from the everyday documents.\n";
  }
  if (folder === LOCALIZATION) {
    return "# Localization\n\nTranslations, glossaries and style notes for every language the driver app speaks, one folder per language.\n";
  }
  if (!profile) throw new Error(`no profile for ${folder}`);
  return [`# ${profile.name}`, "", profile.about, "", ...(profile.topics.length > 0 ? ["## Current work", "", ...profile.topics.map((tp) => `* **${tp.title}.** ${tp.summary}`), ""] : [])].join("\n");
}

function rootReadme(links: string[]): string {
  const link = (text: string, target: string) => {
    links.push(target);
    return `[${text}](${relativeLink("README.md", target)})`;
  };
  return [
    `# ${COMPANY} documentation`,
    "",
    `${COMPANY} plans delivery routes for local couriers: a web console for planners, an app for drivers and an API for the shops that send orders. This repository holds the documentation of its teams.`,
    "",
    "| Folder | Team | What is in it |",
    "| --- | --- | --- |",
    `| ${link("eng", "eng/README.md")} | Engineering | Design docs, RFCs, runbooks, postmortems, meeting notes and project pages |`,
    `| ${link("docs", "docs/README.md")} | Documentation | The company handbook, release notes and the Markdown reference |`,
    `| ${link("support", `${COMBINED.folder}/README.md`)} | Documentation | The help center for customers and partners |`,
    `| ${LOOSE} | Everyone | Scripts, data exports and personal notes that are not published |`,
    "",
    "Unusual files used to check formatting live in `eng/edge-cases` and `eng/edge-cases (team zone)`, away from the everyday documents.",
    "",
  ].join("\n");
}

/** The annotated README.md files and the corpus root files. */
export function treeFiles(_rng: Rng, canaries: Canaries, hookRevision: string): CorpusFile[] {
  const rootLinks: string[] = [];
  const root = annotated("README.md", [], rootReadme(rootLinks), canaries.take());
  const files: CorpusFile[] = [
    { ...root, group: "unsynced", synced: false, links: rootLinks, note: "no annotation: nothing above it is synced" },
    annotated("eng/README.md", ["linear-team: ENG"], teamReadme("eng"), canaries.take()),
    annotated("docs/README.md", ["linear-team: DOCS"], teamReadme("docs"), canaries.take()),
    annotated(`${COMBINED.folder}/README.md`, [`linear-team: ${COMBINED.team}`, `linear-project: ${COMBINED.placeholder}`], projectReadme(COMBINED.folder), canaries.take()),
  ];
  for (const { folder, placeholder } of [...ENG_PROJECTS, ...DOCS_PROJECTS]) {
    files.push(annotated(`${folder}/README.md`, [`linear-project: ${placeholder}`], projectReadme(folder), canaries.take()));
  }
  files.push(
    markdownFile({ path: ".gitattributes", content: Buffer.from(gitattributes()), group: "support", kind: "other", synced: false }),
    markdownFile({ path: ".pre-commit-config.yaml", content: Buffer.from(preCommitConfig(hookRevision)), group: "support", kind: "other", synced: false }),
  );
  return files;
}

/**
 * The corpus's pre-commit configuration: the Linear-format hook, whose
 * release commit the caller supplies, and a test security hook that rejects a
 * fake secret pattern and needs no toolchain.
 */
export function preCommitConfig(hookRevision: string): string {
  validateSha(hookRevision);
  return [
    "repos:",
    "  - repo: https://github.com/mikhail-yaskou/mdbisync",
    `    rev: ${hookRevision}`,
    "    hooks:",
    "      - id: linear-format",
    "  - repo: local",
    "    hooks:",
    "      - id: test-secret",
    "        name: test secret pattern",
    "        alias: security",
    "        language: pygrep",
    "        entry: 'TESTKEY-[0-9a-f]{24}'",
    "        stages: [pre-commit, pre-push]",
    "",
  ].join("\n");
}

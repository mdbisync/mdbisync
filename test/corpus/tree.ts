// The corpus tree: team and project folders with their annotations, the
// folders where generated files live, and the files at the corpus root.

import { gitattributes, markdownFile, type Canaries, type CorpusFile } from "./model.ts";
import type { Rng } from "./rng.ts";
import { paragraph } from "./text.ts";

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
];
export const DOCS_PROJECTS = [
  { folder: "docs/handbook", placeholder: "PROJECT_DOCS_1" },
  { folder: "docs/release notes", placeholder: "PROJECT_DOCS_2" },
  { folder: "docs/reference", placeholder: "PROJECT_DOCS_3" },
];
export const COMBINED = { folder: "combined", placeholder: "PROJECT_COMBINED", team: "DOCS" as const };

/** The fixture bank is copied here, keeping its own folder layout. */
export const BANK_HOME = "docs/reference";
/** Files above every annotation. */
export const LOOSE = "loose";
/** Team-zone folder for the duplicate-title pairs. */
export const COLLISIONS = "eng/collisions";

/** Team-zone areas of ENG; their names exercise spaces, dots, parentheses and other scripts. */
const ENG_AREAS = ["eng/backend", "eng/frontend", "eng/infra", "eng/on-call (rotation)", "eng/notes.v2", "eng/Ελληνικά", "eng/設計", "eng/🚀 launches"];

/** Where generated documents may be placed; the bank's project is kept for the bank. */
export const HOMES: Home[] = [
  ...ENG_AREAS.map((path): Home => ({ path, scope: "team", team: "ENG" })),
  ...ENG_PROJECTS.map(({ folder }): Home => ({ path: folder, scope: "project", team: "ENG" })),
  ...DOCS_PROJECTS.filter((p) => p.folder !== BANK_HOME).map(({ folder }): Home => ({ path: folder, scope: "project", team: "DOCS" })),
  { path: COMBINED.folder, scope: "project", team: "DOCS" },
];

function readme(path: string, frontMatter: string[], heading: string, rng: Rng, canary: string): CorpusFile {
  const front = frontMatter.length > 0 ? `---\n${frontMatter.join("\n")}\n---\n\n` : "";
  const body = `${front}# ${heading}\n\n${paragraph(rng)}\n\nReference: ${canary}\n`;
  return markdownFile({ path, content: Buffer.from(body), group: "annotations", canary, canaryIn: "content" });
}

/** The annotated README.md files and the corpus root files. */
export function treeFiles(rng: Rng, canaries: Canaries): CorpusFile[] {
  const files: CorpusFile[] = [
    { ...readme("README.md", [], "Test corpus", rng, canaries.take()), group: "unsynced", synced: false, note: "no annotation: nothing above it is synced" },
    readme("eng/README.md", ["linear-team: ENG"], "Engineering", rng, canaries.take()),
    readme("docs/README.md", ["linear-team: DOCS"], "Documentation", rng, canaries.take()),
    readme(`${COMBINED.folder}/README.md`, [`linear-team: ${COMBINED.team}`, `linear-project: ${COMBINED.placeholder}`], "Combined space", rng, canaries.take()),
  ];
  for (const { folder, placeholder } of [...ENG_PROJECTS, ...DOCS_PROJECTS]) {
    files.push(readme(`${folder}/README.md`, [`linear-project: ${placeholder}`], folder.split("/").pop() as string, rng, canaries.take()));
  }
  files.push(
    markdownFile({ path: ".gitattributes", content: Buffer.from(gitattributes()), group: "support", kind: "other", synced: false }),
    markdownFile({ path: ".pre-commit-config.yaml", content: Buffer.from(preCommitConfig()), group: "support", kind: "other", synced: false }),
  );
  return files;
}

/**
 * The corpus's pre-commit configuration: the Linear-format hook, whose
 * release the harness fills in, and a test security hook that rejects a
 * fake secret pattern and needs no toolchain.
 */
export function preCommitConfig(): string {
  return [
    "repos:",
    "  - repo: https://github.com/mikhail-yaskou/mdbisync",
    "    rev: HOOK_REV_PLACEHOLDER",
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

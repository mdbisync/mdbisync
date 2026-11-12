// Copies the hash-checked pre-commit list, `.github/requirements/pre-commit.txt`,
// into everything that carries it inline: the "Install pre-commit" step of each
// workflow template in `examples/`, the init copies in `src/init/workflows.json`
// and the version the quickstart names.
//
// The requirements file is the one GitHub's dependency graph, dependency review
// and Dependabot read. The templates are copied into other repositories, so they
// cannot read the file and hold their own copy of it. After a change to the file
// (a Dependabot update of the pre-commit group, say), run
// `npm run sync:pre-commit-pins` and commit the result; the workflow tests fail
// until the copies equal the file.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SYNC_COMMAND = 'npm run sync:pre-commit-pins';
export const REQUIREMENTS_PATH = '.github/requirements/pre-commit.txt';

/** The pre-commit version a requirements list pins. */
export function preCommitVersion(requirements: string): string {
  const version = /^pre-commit==([^\s\\]+)/m.exec(requirements)?.[1];
  if (!version) throw new Error(`${REQUIREMENTS_PATH} must pin pre-commit`);
  return version;
}

/**
 * The template with its "Install pre-commit" step carrying `requirements`: the
 * list between `<<'REQUIREMENTS'; then` and the closing `REQUIREMENTS` line,
 * and every `pre-commit <version>` the step names. The rest of the text stays
 * byte for byte. A template without that step is returned unchanged.
 */
export function syncTemplate(text: string, requirements: string): string {
  const step = /^( *)- name: Install pre-commit\n(?:\1 {2}.*\n|\n)*/m.exec(text);
  if (!step) return text;
  const version = preCommitVersion(requirements);
  const lines = requirements.trim().split('\n');
  const synced = step[0]
    .replace(/(<<'REQUIREMENTS'; then\n)[\s\S]*?\n( *)REQUIREMENTS\n/, (_, opening: string, indent: string) =>
      `${opening}${lines.map(line => indent + line).join('\n')}\n${indent}REQUIREMENTS\n`)
    .replace(/\bpre-commit \d+(?:\.\d+)+\b/g, `pre-commit ${version}`);
  return text.slice(0, step.index) + synced + text.slice(step.index + step[0].length);
}

/** The quickstart with its `pre-commit==<version>` install hint set to the list's version. */
export function syncQuickstart(text: string, requirements: string): string {
  return text.replace(/\bpre-commit==\d+(?:\.\d+)+\b/g, `pre-commit==${preCommitVersion(requirements)}`);
}

/** The text of `src/init/workflows.json` for these templates, by file name. */
export function initCopies(templates: Map<string, string>): string {
  const sorted = [...templates].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`;
}

/** Every file the list is copied into, with the text it must have, relative to `root`. */
export function syncedFiles(root: string): Map<string, string> {
  const requirements = readFileSync(join(root, REQUIREMENTS_PATH), 'utf8');
  const files = new Map<string, string>();
  const templates = new Map<string, string>();
  for (const name of readdirSync(join(root, 'examples')).filter(name => name.endsWith('.yml'))) {
    const text = syncTemplate(readFileSync(join(root, 'examples', name), 'utf8'), requirements);
    templates.set(name, text);
    files.set(`examples/${name}`, text);
  }
  files.set('src/init/workflows.json', initCopies(templates));
  files.set('docs/quickstart.md', syncQuickstart(readFileSync(join(root, 'docs/quickstart.md'), 'utf8'), requirements));
  return files;
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, '..');
  for (const [path, text] of syncedFiles(root)) {
    if (readFileSync(join(root, path), 'utf8') === text) continue;
    writeFileSync(join(root, path), text);
    console.log(`updated ${path}`);
  }
}

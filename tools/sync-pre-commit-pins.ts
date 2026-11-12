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
const INIT_COPIES = 'src/init/workflows.json';

/**
 * The pre-commit version a requirements list pins. Only a release version
 * (`4.7.0`) is accepted: the templates name it in plain text, where a
 * pre-release suffix could not be told apart from the words around it.
 */
export function preCommitVersion(requirements: string): string {
  const version = /^pre-commit==([^\s\\]+)/m.exec(requirements)?.[1];
  if (!version) throw new Error(`${REQUIREMENTS_PATH} must pin pre-commit`);
  if (!/^\d+(?:\.\d+)+$/.test(version)) throw new Error(`${REQUIREMENTS_PATH} must pin a release of pre-commit, not ${version}`);
  return version;
}

const HEREDOC = /(<<'REQUIREMENTS'; then\n)[\s\S]*?\n( *)REQUIREMENTS\n/g;

/**
 * The template with each "Install pre-commit" step carrying `requirements`:
 * the list between `<<'REQUIREMENTS'; then` and the closing `REQUIREMENTS`
 * line, and every `pre-commit <version>` the step names. The rest of the text
 * stays byte for byte. Throws when a list sits outside such a step, which the
 * command could not keep in step.
 */
export function syncTemplate(text: string, requirements: string): string {
  const version = preCommitVersion(requirements);
  const lines = requirements.trim().split('\n');
  let lists = 0;
  const synced = text.replace(/^( *)- name: Install pre-commit\n(?:\1 {2}.*\n|\n)*/gm, step => step
    .replace(HEREDOC, (_, opening: string, indent: string) => {
      lists += 1;
      return `${opening}${lines.map(line => indent + line).join('\n')}\n${indent}REQUIREMENTS\n`;
    })
    .replace(/\bpre-commit \d+(?:\.\d+)+\b/g, `pre-commit ${version}`));
  if ((text.match(HEREDOC) ?? []).length !== lists) {
    throw new Error('a REQUIREMENTS list sits outside a step named "Install pre-commit" (with `- name:` first); move it into one');
  }
  return synced;
}

/** The quickstart with its `pre-commit==<version>` install hint set to the list's version. */
export function syncQuickstart(text: string, requirements: string): string {
  return text.replace(/\bpre-commit==\d+(?:\.\d+)+\b/g, `pre-commit==${preCommitVersion(requirements)}`);
}

/** Every file the list is copied into, with the text it must have, relative to `root`. */
export function syncedFiles(root: string): Map<string, string> {
  const requirements = readFileSync(join(root, REQUIREMENTS_PATH), 'utf8');
  const files = new Map<string, string>();
  for (const name of readdirSync(join(root, 'examples')).filter(name => name.endsWith('.yml'))) {
    files.set(`examples/${name}`, syncTemplate(readFileSync(join(root, 'examples', name), 'utf8'), requirements));
  }
  // `init` writes the templates it already lists; a new example joins them only by hand.
  const copies = JSON.parse(readFileSync(join(root, INIT_COPIES), 'utf8')) as Record<string, string>;
  for (const name of Object.keys(copies)) {
    const text = files.get(`examples/${name}`);
    if (text === undefined) throw new Error(`${INIT_COPIES} lists ${name}, which examples/ lacks`);
    copies[name] = text;
  }
  files.set(INIT_COPIES, `${JSON.stringify(copies, null, 2)}\n`);
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

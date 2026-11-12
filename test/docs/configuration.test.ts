// The configuration reference and the quickstart against the code: every
// action input with its required flag, default and command-line variable,
// every output, the secrets and the variable the workflows read, the init
// flags and the commands. The defaults in `action.yml` must also be the
// ones the code uses when an input is empty, which is what the command line
// and an older workflow without the input get.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { parseOperation } from '../../src/action/main.ts';
import { COMMANDS } from '../../src/commands.ts';
import { INIT_SECURITY_FLAGS, INIT_USAGE, INIT_VALUE_FLAGS } from '../../src/init/command.ts';
import { MINIMUM_RELEASE } from '../../src/init/releases.ts';
import templates from '../../src/init/workflows.json' with { type: 'json' };
import { PROJECT_KEY, TEAM_KEY } from '../../src/mapping/annotations.ts';
import { DEFAULT_DOCUMENT_CAP } from '../../src/run/capacity.ts';
import { INPUT_NAMES, type InputName, environmentName } from '../../src/run/inputs.ts';
import { LINEAR_FORMAT_HOOK } from '../../src/setup/hooks.ts';
import { DEFAULT_STATE_CONFIG } from '../../src/state/index.ts';
import { DEFAULT_CHECK_DEADLINE_MINUTES } from '../../src/sync/deadline.ts';
import { DEFAULT_MERGE_GRACE_SECONDS } from '../../src/sync/pull-request.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const PAGE = read('docs/configuration.md');
const QUICKSTART = read('docs/quickstart.md');

interface ActionInput { description: string; required: boolean; default?: string }
const ACTION = parse(read('action.yml')) as { inputs: Record<string, ActionInput>; outputs: Record<string, { description: string }> };

/** The rows of the table under `heading` (any level), as cells, without the header. */
function table(markdown: string, heading: string): string[][] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^#{2,6} /.test(line) && line.replace(/^#+ /, '') === heading);
  assert.notEqual(start, -1, `the page has a section "${heading}"`);
  const rows: string[][] = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6} /.test(line)) break;
    if (line.startsWith('|')) {
      inTable = true;
      rows.push(line.trim().slice(1, -1).split('|').map((cell) => cell.trim()));
    } else if (inTable) break;
  }
  return rows.slice(2);
}

/** A table keyed by the code in its first cell. */
function byName(rows: string[][]): Map<string, string[]> {
  return new Map(rows.map((row) => [/^`([^`]+)`$/.exec(row[0] ?? '')?.[1] ?? row[0] ?? '', row]));
}

/** The default the code uses when the input is empty, for each input that has one. */
const CODE_DEFAULTS: Record<string, string> = {
  operation: parseOperation(''),
  'tracked-branch': DEFAULT_STATE_CONFIG.trackedBranch,
  'sync-branch': DEFAULT_STATE_CONFIG.syncBranch,
  'state-ref-prefix': DEFAULT_STATE_CONFIG.refPrefix,
  'document-cap': String(DEFAULT_DOCUMENT_CAP),
  'merge-grace-seconds': String(DEFAULT_MERGE_GRACE_SECONDS),
  'check-deadline-minutes': String(DEFAULT_CHECK_DEADLINE_MINUTES),
  'cleanup-tokens': 'false',
};

/** The secrets and variables the workflows `init` writes read, from lines that are not comments. */
function workflowSettings(): Set<string> {
  const found = new Set<string>();
  for (const text of Object.values(templates)) {
    for (const line of text.split('\n')) {
      if (line.trim().startsWith('#')) continue;
      for (const match of line.matchAll(/\$\{\{\s*(secrets|vars)\.(\w+)\s*\}\}/g)) found.add(`${match[1] === 'vars' ? 'Variable' : 'Secret'} ${match[2]}`);
    }
  }
  return found;
}

describe('configuration reference', () => {
  const inputs = byName(table(PAGE, 'Action inputs'));

  it('lists exactly the inputs of action.yml', () => {
    assert.deepEqual([...inputs.keys()].sort(), Object.keys(ACTION.inputs).sort());
  });

  for (const [name, input] of Object.entries(ACTION.inputs)) {
    it(`gives ${name} its required flag, default and command-line variable`, () => {
      const [, required, value, cli] = inputs.get(name) ?? [];
      assert.equal(required, input.required ? 'yes' : 'no');
      const fallback = input.default ?? '';
      assert.equal(value, fallback === '' ? 'none' : `\`${fallback}\``);
      if ((INPUT_NAMES as readonly string[]).includes(name)) assert.equal(cli, `\`${environmentName(name as InputName)}\``);
      else assert.match(cli ?? '', /^action only/);
    });
  }

  it('documents the defaults the code uses for an empty input', () => {
    for (const [name, value] of Object.entries(CODE_DEFAULTS)) {
      assert.equal(ACTION.inputs[name]?.default, value, `action.yml default of ${name}`);
    }
    const withDefault = Object.entries(ACTION.inputs).filter(([, input]) => (input.default ?? '') !== '').map(([name]) => name);
    assert.deepEqual(withDefault.sort(), Object.keys(CODE_DEFAULTS).sort(), 'every non-empty default is checked against the code');
  });

  it('lists exactly the outputs of action.yml', () => {
    assert.deepEqual([...byName(table(PAGE, 'Action outputs')).keys()].sort(), Object.keys(ACTION.outputs).sort());
  });

  it('lists exactly the secrets and the variable the workflows read', () => {
    const listed = table(PAGE, 'Repository secrets and variable').map(([kind, name]) => `${kind} ${name?.replace(/`/g, '')}`);
    assert.deepEqual(listed.sort(), [...workflowSettings()].sort());
  });

  it('lists every init flag, as init accepts and its help shows them', () => {
    const accepted = [...INIT_VALUE_FLAGS, ...INIT_SECURITY_FLAGS].sort();
    assert.deepEqual([...byName(table(PAGE, 'init')).keys()].sort(), accepted);
    assert.deepEqual([...new Set(INIT_USAGE.match(/--[a-z][a-z-]+/g))].sort(), accepted, 'init --help');
  });

  it('names the oldest release init writes, in the flag table and the text below it', () => {
    assert.match(byName(table(PAGE, 'init')).get('--release-sha')?.join(' ') ?? '', new RegExp(`\`${MINIMUM_RELEASE.version.replaceAll('.', '\\.')}\` or a later release`));
    const section = PAGE.slice(PAGE.indexOf('### init'), PAGE.indexOf('## Tokens left'));
    assert.equal(section.split(`\`${MINIMUM_RELEASE.version}\``).length - 1, 2, 'the flag table and the text below it name the release');
  });

  it('lists every command', () => {
    assert.deepEqual([...byName(table(PAGE, 'Command line')).keys()].sort(), Object.keys(COMMANDS).sort());
  });

  it('names the annotation keys and the required hook', () => {
    assert.deepEqual([...byName(table(PAGE, 'Folder annotations')).keys()].sort(), [PROJECT_KEY, TEAM_KEY].sort());
    assert.ok(byName(table(PAGE, 'Pre-commit hooks')).has(LINEAR_FORMAT_HOOK));
  });
});

describe('quickstart', () => {
  it('names every secret and variable the workflows read, with its kind', () => {
    for (const setting of workflowSettings()) {
      const [kind, name] = setting.split(' ');
      assert.ok(QUICKSTART.includes(`| ${kind} | \`${name}\` |`), `docs/quickstart.md sets ${setting}`);
    }
  });

  it('names every file init writes', () => {
    for (const name of Object.keys(templates)) assert.ok(QUICKSTART.includes(`\`.github/workflows/${name}\``), name);
    assert.ok(QUICKSTART.includes('`.pre-commit-config.yaml`'));
  });

  it('pins the CLI and the hook to the same release placeholder', () => {
    assert.match(QUICKSTART, /npm exec --yes --package=git\+https:\/\/github\.com\/mdbisync\/mdbisync\.git#<release-sha> --/);
    assert.match(QUICKSTART, /mdbisync init --release-sha <release-sha>/);
    assert.match(QUICKSTART, /rev: <release-sha>/);
  });
});

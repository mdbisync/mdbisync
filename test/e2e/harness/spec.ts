// Scenario specs: loading, typing and choosing which to run.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateScenario } from '../../scenarios/schema.ts';

export const SCENARIO_DIR = fileURLToPath(new URL('../../scenarios/', import.meta.url));

export type StepKind = 'git' | 'linear' | 'run' | 'fault' | 'kill' | 'merge' | 'ui';
export type Slice = 'mini' | 'bank' | 'mid' | 'full';
export type Mode = 'local' | 'actions' | 'ui';
export type SetupState = 'offline' | 'empty' | 'converged' | 'no-state' | 'linear-seeded' | 'conflicted';
export type InvariantId = 'I1' | 'I2' | 'I3' | 'I4' | 'I5' | 'I6' | 'I7' | 'I8' | 'I9';
export const INVARIANTS: readonly InvariantId[] = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9'];
export const LEVELS = ['L0', 'L1', 'L1R', 'L2', 'L3', 'L4', 'L5', 'L6'] as const;
export type Level = (typeof LEVELS)[number];

export interface Step {
  kind: StepKind;
  action: string;
  args: Record<string, unknown>;
}

export interface Assertion {
  subject: string;
  operator: 'equal' | 'same-as' | 'contains-all' | 'at-most' | 'at-least';
  expected: unknown;
}

export interface Scenario {
  version: 1;
  id: string;
  slice: Slice;
  mode: Mode;
  setup: { state: SetupState; fixtures: string[]; teamZoneLock: boolean };
  steps: Step[];
  checks: {
    invariants: Record<InvariantId, { required: boolean; reason?: string }>;
    assertions: Assertion[];
  };
  proposedRule?: string;
}

export function levelOf(id: string): Level {
  const level = /^(L(?:1R|[0-6]))-/.exec(id)?.[1];
  if (level === undefined) throw new Error(`not a scenario id: ${id}`);
  return level as Level;
}

/** Loads every spec, validated by the schema, in catalog order. */
export function loadScenarios(dir: string = SCENARIO_DIR): Scenario[] {
  const catalog = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8')) as string[];
  const files = new Set(readdirSync(dir).filter((name) => name.endsWith('.yaml')));
  return catalog.map((id) => {
    const filename = `${id}.yaml`;
    if (!files.has(filename)) throw new Error(`no spec for ${id}`);
    const value: unknown = JSON.parse(readFileSync(join(dir, filename), 'utf8'));
    validateScenario(value, filename);
    return value as Scenario;
  });
}

export interface Selection {
  ids?: readonly string[];
  levels?: readonly string[];
  slices?: readonly string[];
  modes?: readonly string[];
}

/**
 * Chooses scenarios: by id, by level, by slice and by mode. Filters of
 * different kinds all apply; an unknown id or level is an error, so a typo
 * never runs an empty set that looks green.
 */
export function selectScenarios(all: readonly Scenario[], selection: Selection): Scenario[] {
  const known = new Set(all.map((scenario) => scenario.id));
  for (const id of selection.ids ?? []) if (!known.has(id)) throw new Error(`unknown scenario id: ${id}`);
  for (const level of selection.levels ?? []) {
    if (!(LEVELS as readonly string[]).includes(level)) throw new Error(`unknown level: ${level}`);
  }
  const has = (filter: readonly string[] | undefined, value: string) => filter === undefined || filter.length === 0 || filter.includes(value);
  return all.filter(
    (scenario) =>
      has(selection.ids, scenario.id) &&
      has(selection.levels, levelOf(scenario.id)) &&
      has(selection.slices, scenario.slice) &&
      has(selection.modes, scenario.mode),
  );
}

// Zone concurrency is opt-in. A scenario id alone is insufficient: changes
// to setup, steps or assertions must return the scenario to exclusive mode.
import { INVARIANTS, type Scenario } from './spec.ts';

export function zoneConcurrent(scenario: Scenario): boolean {
  if (scenario.id !== 'L1-05' || scenario.slice !== 'mini' || scenario.mode !== 'local' || scenario.version !== 1) return false;
  if (scenario.setup.state !== 'empty' || !scenario.setup.teamZoneLock || JSON.stringify(scenario.setup.fixtures) !== '["mini"]') return false;
  const [step] = scenario.steps;
  if (scenario.steps.length !== 1 || step?.kind !== 'run' || step.action !== 'initial-sync' ||
      step.args.direction !== 'git-to-linear' || step.args.confirm !== true || Object.keys(step.args).sort().join(',') !== 'confirm,direction') return false;
  if (Object.keys(scenario.checks.invariants).length !== INVARIANTS.length || INVARIANTS.some((id) => !scenario.checks.invariants[id]?.required)) return false;
  const expected = [
    { subject: 'documents.mapping', operator: 'same-as', expected: 'expected.annotationMapping' },
    { subject: 'documents.unsyncedPaths', operator: 'equal', expected: [] },
  ];
  return JSON.stringify(scenario.checks.assertions) === JSON.stringify(expected);
}

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateScenario } from './scenarios/schema.ts';
import { LEFT_OUT_AT_WRITE_RULES, LEFT_OUT_RULES, RECORD_LEFT_OUT_RULES, UNSYNCED_REASONS } from '../src/codes.ts';
import { LINT_RULES } from '../src/format/rules.ts';

const scenarioDirectory = fileURLToPath(new URL('./scenarios/', import.meta.url));

test('left-out expectations accept engine rules and reject unknown names', () => {
  const scenario = JSON.parse(readFileSync(join(scenarioDirectory, 'L5-12.yaml'), 'utf8'));
  const assertion: { subject: string; operator: string; expected: unknown } = {
    subject: 'summary.leftOutRules', operator: 'contains-all', expected: [],
  };
  scenario.checks.assertions = [assertion];
  for (const operator of ['contains-all', 'equal']) {
    assertion.operator = operator;
    assertion.expected = [...Object.keys(LINT_RULES), ...UNSYNCED_REASONS, ...LEFT_OUT_RULES, ...LEFT_OUT_AT_WRITE_RULES, ...RECORD_LEFT_OUT_RULES];
    validateScenario(scenario, 'L5-12.yaml');
    // One literal from each report source also checks the choice of tables.
    assertion.expected = ['footnote', 'stored-in-lfs', 'title-too-long', 'upload-unreadable', 'download-failed'];
    validateScenario(scenario, 'L5-12.yaml');
    for (const rule of ['lfs-object-missing', 'escaped-pipe', 'unknown-rule', 42]) {
      assertion.expected = ['upload-unreadable', rule];
      assert.throws(() => validateScenario(scenario, 'L5-12.yaml'), /unknown summary.leftOutRules rule/);
    }
  }
  assertion.expected = [];
  validateScenario(scenario, 'L5-12.yaml');
  assertion.expected = null;
  validateScenario(scenario, 'L5-12.yaml');
  assertion.expected = 'upload-unreadable';
  assert.throws(() => validateScenario(scenario, 'L5-12.yaml'), /expects an array/);
  assertion.operator = 'same-as';
  assertion.expected = 'previous.leftOutRules';
  validateScenario(scenario, 'L5-12.yaml');
});

for (const filename of readdirSync(scenarioDirectory).filter(name => /\.ya?ml$/i.test(name))) {
  test(`schema ${filename}`, () => {
    validateScenario(JSON.parse(readFileSync(join(scenarioDirectory, filename), 'utf8')), basename(filename));
  });
}

test('schema rejects malformed scenarios', () => {
  const valid = JSON.parse(readFileSync(join(scenarioDirectory, 'L1-12.yaml'), 'utf8'));
  const mutations: [(s: any) => void, RegExp][] = [
    [s => { s.id = 'L9-01'; }, /did not match/],
    [s => { s.version = 2; }, /2 !== 1/],
    [s => { s.slice = 'small'; }, /invalid slice/],
    [s => { s.slice = ['mini']; }, /invalid slice/],
    [s => { s.mode = ['local']; }, /invalid mode/],
    [s => { s.steps[0].kind = ['run']; }, /invalid step kind/],
    [s => { s.mode = 'browser'; }, /invalid mode/],
    [s => { s.steps = []; }, /expected nonempty array/],
    [s => { s.steps[0].kind = 'shell'; }, /invalid step kind/],
    [s => { s.steps[0].args = null; }, /expected object/],
    [s => { s.steps[0].action = 'typo'; }, /unknown action/],
    [s => { s.steps[0].args.confirm = 'true'; }, /confirm must be boolean/],
    [s => { delete s.steps[0].args.confirm; }, /missing argument confirm/],
    [s => { s.steps[0].args.unknown = true; }, /unknown argument unknown/],
    [s => { s.checks.assertions = []; }, /expected nonempty array/],
    [s => { s.checks.assertions[0].operator = 'truthy'; }, /invalid assertion operator/],
    [s => { delete s.checks.invariants.I9; }, /missing I9/],
    [s => { s.checks.invariants.I1 = { required: false }; }, /missing reason/],
    [s => { delete s.proposedRule; }, /expected nonempty text/],
    [s => { s.unrecognized = true; }, /unknown unrecognized/],
  ];
  for (const [mutate, message] of mutations) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.throws(() => validateScenario(invalid, 'L1-12.yaml'), message);
  }
  assert.throws(() => validateScenario(valid, 'L1-11.yaml'), /filename must match ID/);
});

test('operation arguments and step ordering reject invalid contracts', () => {
  function rejects(id: string, mutate: (scenario: any) => void, message: RegExp) {
    const scenario = JSON.parse(readFileSync(join(scenarioDirectory, `${id}.yaml`), 'utf8'));
    mutate(scenario);
    assert.throws(() => validateScenario(scenario, `${id}.yaml`), message);
  }
  rejects('L1-12', s => { s.steps[0].args.direction = 'reverse'; }, /invalid direction/);
  rejects('L1-20', s => { delete s.steps[0].args.direction; }, /missing argument direction/);
  rejects('L1-20', s => { s.steps[0].args.command = 'inital-sync'; }, /invalid command/);
  rejects('L4-10', s => { s.steps[0].args.events = ['pushh']; }, /invalid event/);
  rejects('L6-08', s => { s.steps[2].args.actors = ['editr-b']; }, /invalid editor role/);
  rejects('L6-06', s => { s.steps.splice(1, 1); }, /UI editor must be verified/);
  rejects('L6-01', s => { s.steps[0].args.requireIdleSeconds = 119; }, /requireIdleSeconds must be at least 120/);
  rejects('L5-06', s => { s.steps[1].args.retryAfter = 5; }, /retryAfter must be null/);
  rejects('L5-06', s => { s.steps[1].args.status = 600; }, /invalid response\/check status/);
  rejects('L5-06', s => { s.steps[1].args.requestNumber = 30.2; }, /requestNumber must be an integer/);
  rejects('L2-06', s => { s.steps[0].args.rewriteFraction = 7; }, /rewriteFraction must be at most 1/);
  rejects('L2-01', s => { s.steps[0].args.direction = 'git-to-linear'; }, /unknown argument direction/);
  rejects('L4-07', s => { s.steps[1].args.status = 429; }, /invalid check status/);
  rejects('L5-07', s => { s.steps[0].args.status = 'passed'; }, /HTTP status must be numeric/);
  rejects('L4-02', s => { s.steps.splice(5, 1); }, /unjoined async run/);
  rejects('L4-02', s => { s.steps[5] = { kind: 'kill', action: 'engine', args: { checkpoint: 'wrong' } }; }, /kill checkpoint does not match/);
});

test('a run.check step before the initial sync is a valid step without arguments', () => {
  const scenario = JSON.parse(readFileSync(join(scenarioDirectory, 'L1-03.yaml'), 'utf8'));
  scenario.steps.unshift({ kind: 'run', action: 'check', args: {} });
  validateScenario(scenario, 'L1-03.yaml');
  scenario.steps[0].args.confirm = true;
  assert.throws(() => validateScenario(scenario, 'L1-03.yaml'), /unknown argument confirm for run.check/);
  scenario.steps[0].args = {};
  scenario.setup.state = 'offline';
  assert.throws(() => validateScenario(scenario, 'L1-03.yaml'), /run.check needs a live setup/);
});

test('a run.check step cannot sit between a checkpoint pause and its asynchronous run', () => {
  const scenario = JSON.parse(readFileSync(join(scenarioDirectory, 'L4-02.yaml'), 'utf8'));
  const pause = scenario.steps.findIndex((step: any) => step.kind === 'fault' && step.action === 'pause');
  assert.ok(pause >= 0);
  scenario.steps.splice(pause + 1, 0, { kind: 'run', action: 'check', args: {} });
  assert.throws(() => validateScenario(scenario, 'L4-02.yaml'), /run.check cannot take an armed checkpoint pause/);
});

test('check fixture modes reject contradictory states', () => {
  const original = JSON.parse(readFileSync(join(scenarioDirectory, 'L5-26.yaml'), 'utf8'));
  for (const args of [
    { status: 'pending', flaky: true },
    { status: 'passed', document: true },
    { status: 'failed', flaky: true, document: true },
    { status: 'failed', reset: true, lane: 'tracked' },
    { status: 'passed', reset: true, lane: 'normal' },
  ]) {
    const scenario = structuredClone(original);
    scenario.steps[2].args = args;
    assert.throws(() => validateScenario(scenario, 'L5-26.yaml'));
  }
});

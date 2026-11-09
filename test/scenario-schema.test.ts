import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateScenario } from './scenarios/schema.ts';

const scenarioDirectory = fileURLToPath(new URL('./scenarios/', import.meta.url));

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
  rejects('L4-02', s => { s.steps.splice(4, 1); }, /unjoined async run/);
  rejects('L4-02', s => { s.steps[4] = { kind: 'kill', action: 'engine', args: { checkpoint: 'wrong' } }; }, /kill checkpoint does not match/);
});

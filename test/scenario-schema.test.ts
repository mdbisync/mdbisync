import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const scenarioDirectory = fileURLToPath(new URL('./scenarios/', import.meta.url));
const kinds = ['git', 'linear', 'run', 'fault', 'kill', 'merge', 'ui'];
const operationArguments: Record<string, readonly string[]> = {
  "fault.annotation-target": ["variants"],
  "fault.budget": ["stopAfterDocuments"],
  "fault.budget-headers": ["includeEndpointLimits", "remaining"],
  "fault.checks": ["name", "status"],
  "fault.clear": [],
  "fault.credentials": ["service", "valid"],
  "fault.golden-drift": ["construct"],
  "fault.hooks": ["linearFormat"],
  "fault.http": ["requestNumber", "retryAfter", "retryAfterSeconds", "status", "times"],
  "fault.merge-policy": ["mergeCommits"],
  "fault.missing-lfs-object": [],
  "fault.pause": ["checkpoint"],
  "fault.permissions": ["missing", "service"],
  "fault.reject-document": ["target"],
  "fault.resume": [],
  "fault.stale-lease": ["ref"],
  "fault.upload-error": [],
  "fault.write-error": ["variants"],
  "git.add": ["bypassHook", "fixture", "path"],
  "git.add-footnote": ["bypassHook"],
  "git.annotation": ["project"],
  "git.ci-fix": ["fixes", "target"],
  "git.close-pr": [],
  "git.conflict-again": [],
  "git.copy": ["target"],
  "git.delete": ["target"],
  "git.delete-refs": ["names"],
  "git.delete-sync-branch": [],
  "git.edit": ["cleanEdits", "conflictingDocuments", "fixture", "target", "workflows"],
  "git.edit-many": ["documents"],
  "git.edit-sync-branch": [],
  "git.front-matter": ["target"],
  "git.image-add": ["documents", "storage"],
  "git.image-change": ["samePath"],
  "git.move": ["destination"],
  "git.move-folder": ["documents"],
  "git.move-rewrite": ["rewriteFraction"],
  "git.open-pr": ["fixture", "workflows"],
  "git.remove-footnote": ["target"],
  "git.remove-security-hooks": [],
  "git.resolve": [],
  "git.scratch-hook": ["fixture", "source"],
  "kill.engine": ["checkpoint"],
  "linear.conflict-again": ["actor"],
  "linear.create": ["actor", "characters", "fixture", "title"],
  "linear.delete-permanently": ["actor", "fixture"],
  "linear.edit": ["actor", "fixture", "target"],
  "linear.edit-inside-markers": ["actor"],
  "linear.edit-many": ["actor", "documents", "teams"],
  "linear.image-add": ["actor"],
  "linear.metadata": ["actor", "variants"],
  "linear.move-project": ["actor", "project"],
  "linear.out-of-scope": ["actor", "variants"],
  "linear.remove-one-marker": ["actor"],
  "linear.remove-secret": ["actor"],
  "linear.rename": ["actor", "title"],
  "linear.repeated-edit": ["actor", "count"],
  "linear.resolve": ["actor"],
  "linear.restore": ["actor", "fixture"],
  "linear.rich-edit": ["actor", "constructs"],
  "linear.trash": ["actor"],
  "merge.pull-request": ["actor"],
  "run.burst": ["durationSeconds", "gitPushesPerMinute", "linearEditsPerMinute"],
  "run.capture": [],
  "run.cleanup": [],
  "run.fix": ["input", "passes"],
  "run.initial-sync": ["confirm", "direction", "wait"],
  "run.lint": ["input"],
  "run.parallel": ["concurrencyGroup", "count"],
  "run.pre-commit": ["allFiles"],
  "run.probe": ["compareGolden", "measure", "passes", "scheduled"],
  "run.resume-until-complete": ["command", "confirm", "direction"],
  "run.scan-canaries": ["scope", "sources"],
  "run.settle": [],
  "run.soak": ["actors", "durationSeconds", "invariantIntervalSeconds", "randomSeed", "scheduleSeconds"],
  "run.sync": ["wait"],
  "run.token-lifecycle": ["outcomes"],
  "run.workflow": ["command", "confirm", "direction", "event"],
  "run.workflow-parallel": ["events", "replacePending"],
  "ui.assert-dom": ["actor"],
  "ui.inspect-blocked": ["actor"],
  "ui.inspect-conflict": ["actor"],
  "ui.inspect-rendering": ["actor", "coverAllConstructs", "group", "sampleCount"],
  "ui.paste-image": ["actor"],
  "ui.rename-trash-restore": ["actor", "title"],
  "ui.resolve-markers": ["actor"],
  "ui.type-during-write": ["actor", "durationSeconds", "target"],
  "ui.type-two-editors": ["actor", "actors"],
  "ui.verify-editor": ["actor", "requireIdleSeconds"],
};
const states = ['offline', 'empty', 'converged', 'no-state', 'linear-seeded', 'conflicted'];
const proposed = new Set(['L1-12', 'L1R-05', 'L3-15', 'L3-16', 'L3-19']);
const idPattern = /^L(?:[0-6]|1R)-\d{2}$/;

type ObjectValue = Record<string, unknown>;
function object(value: unknown): asserts value is ObjectValue {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object');
}
function keys(value: ObjectValue, required: string[], optional: string[] = []) {
  for (const key of required) assert.ok(Object.hasOwn(value, key), `missing ${key}`);
  for (const key of Object.keys(value)) assert.ok([...required, ...optional].includes(key), `unknown ${key}`);
}
function text(value: unknown): asserts value is string {
  assert.ok(typeof value === 'string' && value.trim().length > 0, 'expected nonempty text');
}
function oneOf(value: unknown, options: readonly string[], label: string): asserts value is string {
  assert.ok(typeof value === 'string' && options.includes(value), `invalid ${label}`);
}
function list(value: unknown): asserts value is unknown[] {
  assert.ok(Array.isArray(value) && value.length > 0, 'expected nonempty array');
}

const stringArguments = new Set('actor checkpoint command construct destination direction event fixture group input missing name path project ref scope service source storage target title'.split(' '));
const booleanArguments = new Set('allFiles bypassHook compareGolden concurrencyGroup confirm coverAllConstructs includeEndpointLimits linearFormat mergeCommits replacePending samePath scheduled valid wait workflows'.split(' '));
const numericArguments = new Set('characters cleanEdits conflictingDocuments count documents durationSeconds gitPushesPerMinute invariantIntervalSeconds linearEditsPerMinute passes randomSeed remaining requestNumber requireIdleSeconds retryAfterSeconds rewriteFraction sampleCount scheduleSeconds stopAfterDocuments teams times'.split(' '));
const arrayArguments = new Set('actors constructs events fixes measure names orderings outcomes sources variants'.split(' '));
const requiredArguments: Record<string, string[]> = {
    'run.initial-sync': ['direction', 'confirm'],
    'run.workflow': ['event'],
    'git.move': ['destination'],
    'linear.rename': ['title'],
    'fault.pause': ['checkpoint'],
    'kill.engine': ['checkpoint'],
    'ui.verify-editor': ['requireIdleSeconds'],
};
function validateArguments(kind: string, action: string, args: ObjectValue): void {
  const allowed = operationArguments[`${kind}.${action}`];
  assert.ok(allowed, 'unknown action for step kind');
  for (const [key, value] of Object.entries(args)) {
    assert.ok(allowed.includes(key), `unknown argument ${key} for ${kind}.${action}`);
    if (stringArguments.has(key)) text(value);
    else if (booleanArguments.has(key)) assert.equal(typeof value, 'boolean', `${key} must be boolean`);
    else if (numericArguments.has(key)) {
      assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0, `${key} must be a nonnegative number`);
      if (key === 'rewriteFraction') assert.ok(value <= 1, 'rewriteFraction must be at most 1');
      else assert.ok(Number.isInteger(value), `${key} must be an integer`);
    }
    else if (arrayArguments.has(key)) { list(value); value.forEach(text); }
    else if (key === 'retryAfter') assert.equal(value, null, 'retryAfter must be null when no header is present');
    else if (key === 'status') {
      assert.ok((typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) || ['pending', 'passed', 'failed'].includes(value as string), 'invalid response/check status');
    } else assert.fail(`unknown argument ${key}`);
  }
  for (const field of requiredArguments[`${kind}.${action}`] ?? []) assert.ok(Object.hasOwn(args, field), `missing argument ${field}`);
  if (kind === 'fault' && action === 'checks') oneOf(args.status, ['pending', 'passed', 'failed'], 'check status');
  if (kind === 'fault' && action === 'http') assert.equal(typeof args.status, 'number', 'HTTP status must be numeric');
  if (args.events !== undefined) { list(args.events); for (const event of args.events) oneOf(event, ['push', 'pull_request', 'workflow_dispatch', 'schedule'], 'event'); }
  if (args.actors !== undefined) { list(args.actors); for (const actor of args.actors) oneOf(actor, kind === 'ui' ? ['editor-a', 'editor-b'] : ['editor-a', 'editor-b', 'git'], 'editor role'); }
  if (args.command !== undefined) oneOf(args.command, ['sync', 'initial-sync', 'lint', 'fix', 'init', 'check'], 'command');
  if (args.command === 'initial-sync') for (const field of ['direction', 'confirm']) assert.ok(Object.hasOwn(args, field), `missing argument ${field}`);
  if (args.direction !== undefined) oneOf(args.direction, ['git-to-linear', 'linear-to-git'], 'direction');
  if (args.event !== undefined) oneOf(args.event, ['push', 'pull_request', 'workflow_dispatch', 'schedule'], 'event');
  if (kind === 'ui' && action === 'verify-editor') assert.ok((args.requireIdleSeconds as number) >= 120, 'requireIdleSeconds must be at least 120');
}

/** The files intentionally use the JSON subset of YAML 1.2. Reject other syntax. */
export function validateScenario(value: unknown, filename: string): void {
  object(value);
  keys(value, ['version', 'id', 'slice', 'mode', 'setup', 'steps', 'checks'], ['proposedRule']);
  assert.equal(value.version, 1);
  text(value.id);
  assert.match(value.id, idPattern);
  assert.equal(filename, `${value.id}.yaml`, 'filename must match ID');
  oneOf(value.slice, ['mini', 'bank', 'mid', 'full'], 'slice');
  oneOf(value.mode, ['local', 'actions', 'ui'], 'mode');
  object(value.setup);
  keys(value.setup, ['state', 'fixtures', 'teamZoneLock']);
  oneOf(value.setup.state, states, 'setup state');
  assert.equal(typeof value.setup.teamZoneLock, 'boolean');
  list(value.setup.fixtures);
  value.setup.fixtures.forEach(text);
  list(value.steps);
  let pausedAt: string | undefined;
  let asynchronous = false;
  const verifiedEditors = new Set<string>();
  for (const step of value.steps) {
    object(step);
    keys(step, ['kind', 'action', 'args']);
    oneOf(step.kind, kinds, 'step kind');
    text(step.action);
    object(step.args);
    validateArguments(step.kind, step.action, step.args);
    if (step.kind === 'linear' || step.kind === 'ui') {
      oneOf(step.args.actor, ['editor-a', 'editor-b'], 'editor role');
    }
    if (step.kind === 'fault' && step.action === 'pause') {
      assert.ok(!pausedAt && !asynchronous, 'nested checkpoint pause');
      pausedAt = step.args.checkpoint as string;
    }
    if (step.kind === 'run' && step.args.wait === false) {
      assert.ok(pausedAt && !asynchronous, 'async run needs an armed checkpoint');
      asynchronous = true;
    }
    if (step.kind === 'kill' || (step.kind === 'fault' && step.action === 'resume')) {
      assert.ok(asynchronous, 'resume or kill needs an async run');
      if (step.kind === 'kill') assert.equal(step.args.checkpoint, pausedAt, 'kill checkpoint does not match active pause');
      pausedAt = undefined;
      asynchronous = false;
    }
    if (step.kind === 'ui') {
      assert.equal(value.mode, 'ui', 'UI steps require UI mode');
      if (step.action === 'verify-editor') verifiedEditors.add(step.args.actor as string);
      else {
        const actors = step.args.actors ?? [step.args.actor];
        list(actors);
        for (const actor of actors) assert.ok(verifiedEditors.has(actor as string), 'UI editor must be verified before input');
      }
    }
  }
  assert.ok(!asynchronous && !pausedAt, 'unjoined async run or unused pause');
  if (value.mode === 'ui') assert.ok(value.steps.some(s => { object(s); return s.kind === 'ui'; }));
  object(value.checks);
  keys(value.checks, ['invariants', 'assertions']);
  object(value.checks.invariants);
  keys(value.checks.invariants, Array.from({ length: 9 }, (_, i) => `I${i + 1}`));
  for (const invariant of Object.values(value.checks.invariants)) {
    object(invariant);
    assert.equal(typeof invariant.required, 'boolean');
    keys(invariant, invariant.required ? ['required'] : ['required', 'reason']);
    if (!invariant.required) text(invariant.reason);
  }
  list(value.checks.assertions);
  for (const assertion of value.checks.assertions) {
    object(assertion);
    keys(assertion, ['subject', 'operator', 'expected']);
    text(assertion.subject);
    assert.match(assertion.subject, /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*$/);
    oneOf(assertion.operator, ['equal', 'same-as', 'contains-all', 'at-most', 'at-least'], 'assertion operator');
    if (assertion.operator === 'same-as') {
      text(assertion.expected);
      assert.match(assertion.expected, /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*$/);
    }
    if (assertion.operator === 'contains-all') list(assertion.expected);
    if (assertion.operator === 'at-most' || assertion.operator === 'at-least') {
      assert.ok(typeof assertion.expected === 'number' && Number.isFinite(assertion.expected));
    }
  }
  if (proposed.has(value.id)) text(value.proposedRule);
  else assert.ok(!Object.hasOwn(value, 'proposedRule'), 'unexpected proposed rule');
}

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

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

export const scenarioDirectory = fileURLToPath(new URL('./scenarios/', import.meta.url));
const kinds = ['git', 'linear', 'run', 'fault', 'kill', 'merge', 'ui'];
const actions: Record<string, readonly string[]> = {
  "fault": [
    "annotation-target",
    "budget",
    "budget-headers",
    "checks",
    "clear",
    "credentials",
    "golden-drift",
    "hooks",
    "http",
    "merge-policy",
    "missing-lfs-object",
    "pause",
    "permissions",
    "reject-document",
    "resume",
    "stale-lease",
    "upload-error",
    "write-error"
  ],
  "git": [
    "add",
    "add-footnote",
    "annotation",
    "ci-fix",
    "close-pr",
    "conflict-again",
    "copy",
    "delete",
    "delete-refs",
    "delete-sync-branch",
    "edit",
    "edit-many",
    "edit-sync-branch",
    "front-matter",
    "image-add",
    "image-change",
    "move",
    "move-folder",
    "move-rewrite",
    "open-pr",
    "remove-footnote",
    "remove-security-hooks",
    "resolve",
    "scratch-hook"
  ],
  "kill": [
    "engine"
  ],
  "linear": [
    "conflict-again",
    "create",
    "delete-permanently",
    "edit",
    "edit-inside-markers",
    "edit-many",
    "image-add",
    "metadata",
    "move-project",
    "out-of-scope",
    "remove-one-marker",
    "remove-secret",
    "rename",
    "repeated-edit",
    "resolve",
    "restore",
    "rich-edit",
    "seed",
    "trash"
  ],
  "merge": [
    "pull-request"
  ],
  "run": [
    "burst",
    "capture",
    "check",
    "cleanup",
    "fix",
    "initial-sync",
    "lint",
    "parallel",
    "pre-commit",
    "probe",
    "resume-until-complete",
    "scan-canaries",
    "settle",
    "soak",
    "sync",
    "token-lifecycle",
    "workflow",
    "workflow-parallel"
  ],
  "ui": [
    "assert-dom",
    "inspect-blocked",
    "inspect-conflict",
    "inspect-rendering",
    "paste-image",
    "rename-trash-restore",
    "resolve-markers",
    "type-during-write",
    "type-two-editors",
    "verify-editor"
  ]
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
function list(value: unknown): asserts value is unknown[] {
  assert.ok(Array.isArray(value) && value.length > 0, 'expected nonempty array');
}

/** The files intentionally use the JSON subset of YAML 1.2. Reject other syntax. */
export function validateScenario(value: unknown, filename: string): void {
  object(value);
  keys(value, ['version', 'id', 'slice', 'mode', 'setup', 'steps', 'checks'], ['proposedRule']);
  assert.equal(value.version, 1);
  text(value.id);
  assert.match(value.id, idPattern);
  assert.equal(filename, `${value.id}.yaml`, 'filename must match ID');
  assert.ok(['mini', 'bank', 'mid', 'full'].includes(String(value.slice)), 'invalid slice');
  assert.ok(['local', 'actions', 'ui'].includes(String(value.mode)), 'invalid mode');
  object(value.setup);
  keys(value.setup, ['state', 'fixtures', 'teamZoneLock']);
  assert.ok(states.includes(String(value.setup.state)), 'invalid setup state');
  assert.equal(typeof value.setup.teamZoneLock, 'boolean');
  list(value.setup.fixtures);
  value.setup.fixtures.forEach(text);
  list(value.steps);
  for (const step of value.steps) {
    object(step);
    keys(step, ['kind', 'action', 'args']);
    assert.ok(kinds.includes(String(step.kind)), 'invalid step kind');
    text(step.action);
    assert.ok(actions[String(step.kind)]?.includes(step.action), 'unknown action for step kind');
    object(step.args);
    if (step.kind === 'linear' || step.kind === 'ui') {
      assert.ok(['editor-a', 'editor-b'].includes(String(step.args.actor)), 'invalid editor role');
    }
    if (step.kind === 'ui') assert.equal(value.mode, 'ui', 'UI steps require UI mode');
  }
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
    assert.ok(['equal', 'same-as', 'contains-all', 'at-most', 'at-least'].includes(String(assertion.operator)), 'invalid assertion operator');
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

for (const filename of readdirSync(scenarioDirectory).filter(name => name.endsWith('.yaml'))) {
  test(`schema ${filename}`, () => {
    validateScenario(JSON.parse(readFileSync(join(scenarioDirectory, filename), 'utf8')), basename(filename));
  });
}

test('schema rejects malformed scenarios', () => {
  const valid = JSON.parse(readFileSync(join(scenarioDirectory, 'L1-12.yaml'), 'utf8'));
  const mutations: ((s: any) => void)[] = [
    s => { s.id = 'L9-01'; },
    s => { s.version = 2; },
    s => { s.slice = 'small'; },
    s => { s.mode = 'browser'; },
    s => { s.steps = []; },
    s => { s.steps[0].kind = 'shell'; },
    s => { s.steps[0].args = null; },
    s => { s.steps[0].action = 'typo'; },
    s => { s.checks.assertions = []; },
    s => { s.checks.assertions[0].operator = 'truthy'; },
    s => { delete s.checks.invariants.I9; },
    s => { s.checks.invariants.I1 = { required: false }; },
    s => { delete s.proposedRule; },
    s => { s.unrecognized = true; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.throws(() => validateScenario(invalid, 'L1-12.yaml'));
  }
  assert.throws(() => validateScenario(valid, 'L1-11.yaml'));
});

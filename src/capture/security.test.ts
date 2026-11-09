import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createFixture } from '../state/test-helpers.ts';
import { securityGate } from './security.ts';

it('runs security aliases at both stages and returns no hook output or matched value', async () => {
  const fixture = await createFixture();
  try {
    await fixture.seed({
      '.pre-commit-config.yaml': `repos:
  - repo: local
    hooks:
      - id: content-secret
        alias: security
        name: Content check
        entry: node check.mjs
        language: system
        stages: [pre-commit]
      - id: push-secret
        alias: security
        name: Push check
        entry: node check.mjs
        language: system
        stages: [pre-push]
      - id: unrelated
        name: Must not run
        entry: node -e "process.exit(1)"
        language: system
`,
      'check.mjs': `import {readFileSync} from 'node:fs'; for (const file of process.argv.slice(2)) { if(readFileSync(file,'utf8').includes('private-canary')) { console.log(file+':3: private-canary'); process.exitCode=1; } }`,
    });
    const git = await fixture.clone('hooks');
    const tracked = await git.text(['rev-parse', 'origin/main']);
    const gate = await securityGate(git, tracked);
    assert.equal(gate.configured, true);
    assert.deepEqual(await gate.check(new Map([['docs/plan.md', 'Safe.\n']])), []);
    const findings = await gate.check(new Map([['docs/plan.md', 'private-canary\n']]));
    assert.deepEqual(findings, [{hook: 'content-secret', line: 3}, {hook: 'push-secret', line: 3}]);
    assert.ok(!JSON.stringify(findings).includes('private-canary'));
    // No candidate was added to the real repository, including unreachable objects.
    await gate.close?.();
    const all = await git.text(['cat-file', '--batch-all-objects', '--batch']);
    assert.ok(!all.includes('Safe.'));
  } finally { await fixture.cleanup(); }
});

it('allows single-stage aliases and scans ignored candidates through the index', async () => {
  const fixture = await createFixture();
  let gate: Awaited<ReturnType<typeof securityGate>> | undefined;
  try {
    await fixture.seed({
      '.gitignore': 'private/\n',
      '.pre-commit-config.yaml': `repos:
  - repo: local
    hooks:
      - id: index-check
        alias: security
        name: Index check
        entry: node index-check.mjs
        language: system
        stages: [pre-commit]
`,
      'index-check.mjs': `import {execFileSync} from 'node:child_process'; for(const file of process.argv.slice(2)) {const text=execFileSync('git',['show',':'+file],{encoding:'utf8'}); if(text.includes(['private','canary'].join('-'))) {console.log(file+':2: rejected'); process.exitCode=1;}}`,
    });
    const git = await fixture.clone('staged');
    gate = await securityGate(git, await git.text(['rev-parse', 'origin/main']));
    assert.deepEqual(await gate.check(new Map([['docs/safe.md', 'Safe.\n']])), []);
    assert.deepEqual(await gate.check(new Map([['private/plan.md', 'private-canary\n']])), [{hook: 'index-check', line: 2}]);
  } finally { await gate?.close?.(); await fixture.cleanup(); }
});

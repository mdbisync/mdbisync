import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createFixture } from '../state/test-helpers.ts';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { securityGate } from './security.ts';
import { answeringGate, checkStaged, stagingGate } from './staged.ts';

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

it("never passes a candidate path to pre-commit as an option, so the repository's hooks still run", async () => {
  const fixture = await createFixture();
  let gate: Awaited<ReturnType<typeof securityGate>> | undefined;
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
`,
      'check.mjs': `import {readFileSync} from 'node:fs'; for (const file of process.argv.slice(2)) { if(readFileSync(file,'utf8').includes('private-canary')) { console.log(file+':1: private-canary'); process.exitCode=1; } }`,
    });
    const git = await fixture.clone('options');
    gate = await securityGate(git, await git.text(['rev-parse', 'origin/main']));
    // A second candidate supplies a configuration whose security hook always passes.
    const other = `repos:
  - repo: local
    hooks:
      - id: always-pass
        alias: security
        name: Always pass
        entry: node -e ""
        language: system
        pass_filenames: false
        stages: [pre-commit]
`;
    assert.deepEqual(await gate.check(new Map([['other.md', other]])), []);
    for (const files of [[['other.md', other], ['--config=other.md', 'private-canary\n']], [['-c', 'private-canary\n'], ['other.md', other]], [['--files', 'private-canary\n']], [['-', 'private-canary\n']]] as const) {
      const findings = await gate.check(new Map(files));
      const path = files.find(([, content]) => content !== other)![0];
      assert.ok(findings !== null && findings.length > 0, `${path} passed the gate`);
    }
    // A leading dash below a folder is no option and is scanned as usual.
    assert.deepEqual(await gate.check(new Map([['docs/-c.md', 'private-canary\n']])), [{hook: 'content-secret', line: 1}]);
    assert.deepEqual(await gate.check(new Map([['docs/-c.md', 'Safe.\n']])), []);
  } finally { await gate?.close?.(); await fixture.cleanup(); }
});

it("never lets a candidate replace a script or support file the tracked branch keeps, in process or staged", async () => {
  const fixture = await createFixture();
  let gate: Awaited<ReturnType<typeof securityGate>> | undefined;
  try {
    const script = 'process.exitCode = 0;\n';
    await fixture.seed({
      '.pre-commit-config.yaml': `repos:
  - repo: local
    hooks:
      - id: support-check
        alias: security
        name: Support check
        entry: node docs/scan.mjs
        language: system
`,
      'docs/scan.mjs': script,
      'docs/run.md': 'An executable document.\n',
      'docs/plan.md': 'Original.\n',
      'docs/picture.png': 'Same bytes.\n',
      'docs/stored.png': 'Stored bytes.\n',
    }, {executable: ['docs/run.md'], lfs: ['docs/stored.png']});
    const git = await fixture.clone('support');
    const tracked = await git.text(['rev-parse', 'origin/main']);
    const marker = join(fixture.root, 'hook-canary');
    const payload = `import('node:fs').then((fs) => fs.writeFileSync(${JSON.stringify(marker)}, 'ran'));\n`;
    const refused = [
      new Map([['docs/scan.mjs', payload]]),
      new Map([['docs/plan.md', 'A document.\n'], ['docs/scan.mjs', payload]]),
      new Map([['docs/picture.png', 'Other bytes.\n']]),
      new Map([['docs/stored.png', 'Other bytes.\n']]),
    ];
    const accepted = [
      new Map([['docs/plan.md', 'A document.\n']]),
      new Map([['docs/run.md', 'An edited executable document.\n']]),
      new Map([['docs/new.md', 'A new document.\n'], ['docs/0123.png', 'An asset.\n']]),
      new Map([['docs/plan.md', 'A document.\n'], ['docs/picture.png', 'Same bytes.\n']]),
      // An asset kept in LFS: the candidate holds the bytes its pointer names.
      new Map([['docs/plan.md', 'A document.\n'], ['docs/stored.png', 'Stored bytes.\n']]),
    ];
    // A case-insensitive file system writes an alias over the script; a case-sensitive one keeps it as a new file.
    const alias = new Map([['docs/Scan.mjs', payload]]);
    gate = await securityGate(git, tracked);
    const probe = join(fixture.root, 'Case-Probe');
    await writeFile(probe, '');
    const caseInsensitive = await access(join(fixture.root, 'case-probe')).then(() => true, () => false);
    (caseInsensitive ? refused : accepted).push(alias);
    for (const files of refused) assert.deepEqual(await gate.check(files), [{hook: 'security', line: 1}], [...files.keys()].join());
    for (const files of accepted) assert.deepEqual(await gate.check(files), [], [...files.keys()].join());
    await gate.close?.();
    gate = undefined;
    // The staged steps: the operation records its sets, the hooks step checks them, the operation reads the answers.
    const folder = join(fixture.root, 'stage');
    const staging = await stagingGate(git, tracked, folder);
    for (const files of [...refused, ...accepted]) await staging.check(files);
    await staging.finish();
    const checked = await checkStaged(git, folder, {PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LANG: 'C.UTF-8'});
    assert.equal(checked.rejected, refused.length);
    const answers = await answeringGate(git, tracked, folder);
    for (const files of refused) assert.ok((await answers.check(files))!.length > 0);
    for (const files of accepted) assert.deepEqual(await answers.check(files), []);
    await assert.rejects(readFile(marker), {code: 'ENOENT'}, 'candidate text never runs as a hook script');
  } finally { await gate?.close?.(); await fixture.cleanup(); }
});

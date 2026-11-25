import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createFixture } from '../state/test-helpers.ts';
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { SCRATCH_BATCH_BYTES, type SecurityGate, SecurityScratchBudgetError, SecurityScratchTreeError, checkTitle, securityGate } from './security.ts';
import { randomBytes } from 'node:crypto';
import type { Git } from '../state/index.ts';
import { answeringGate, checkStaged, stagingGate } from './staged.ts';

const FILE_HOOK = `repos:
  - repo: local
    hooks:
      - id: content-check
        alias: security
        name: Content check
        entry: blocked-text
        language: pygrep
        stages: [pre-commit, pre-push]
`;

async function checkFileHookSets(sets: ReadonlyMap<string, string>[], extra: Record<string, string> = {}) {
  const fixture = await createFixture();
  try {
    await fixture.seed({ '.pre-commit-config.yaml': FILE_HOOK, ...extra });
    const git = await fixture.clone('batched-hooks');
    const tracked = await git.text(['rev-parse', 'origin/main']);
    const folder = join(fixture.root, 'stage');
    const bin = join(fixture.root, 'bin');
    const log = join(fixture.root, 'hook-runs');
    await mkdir(bin);
    await writeFile(join(bin, 'pre-commit'), `#!/bin/sh
if [ "$1" = run ]; then printf '%s\\n' "$*" >> "$HOOK_RUNS"; fi
export PATH="$ORIGINAL_PATH"
exec pre-commit "$@"
`, { mode: 0o700 });
    const path = process.env.PATH ?? '';
    const env = { PATH: bin + delimiter + path, HOME: process.env.HOME ?? '', LANG: 'C.UTF-8', ORIGINAL_PATH: path, HOOK_RUNS: log };
    const staged = await stagingGate(git, tracked, folder);
    for (const set of sets) await staged.check(set);
    await staged.finish();
    const result = await checkStaged(git, folder, env);
    const gate = await answeringGate(git, tracked, folder);
    const findings = await Promise.all(sets.map((set) => gate.check(set)));
    const runs = (await readFile(log, 'utf8')).trimEnd().split('\n');
    return { result, findings, runs };
  } finally { await fixture.cleanup(); }
}

it('attributes a finding in any file of a batched set to every set that contains it', async () => {
  const shared = ['docs/shared.md', 'Safe first line.\nblocked-text\n'] as const;
  const { result, findings, runs } = await checkFileHookSets([
    new Map([['docs/first.md', 'Safe.\n'], shared]),
    new Map([['docs/second.md', 'Safe.\n']]),
    new Map([['docs/third.md', 'Safe.\n'], shared]),
  ]);
  const rejected = [{ hook: 'content-check', line: 2 }, { hook: 'content-check', line: 2 }];
  assert.deepEqual(result, { sets: 3, rejected: 2, unanswered: 0 });
  assert.deepEqual(findings, [rejected, [], rejected]);
  assert.ok(runs.some((run) => run.includes('docs/first.md docs/shared.md docs/second.md docs/third.md')));
});

it('checks different contents at the same path in separate batches', async () => {
  const { result, findings, runs } = await checkFileHookSets([
    new Map([['docs/plan.md', 'blocked-text\n'], ['docs/first.md', 'Safe.\n']]),
    new Map([['docs/plan.md', 'Safe.\n'], ['docs/second.md', 'Safe.\n']]),
    new Map([['docs/notes.md', 'Safe.\n']]),
  ]);
  assert.deepEqual(result, { sets: 3, rejected: 1, unanswered: 0 });
  assert.deepEqual(findings, [[{ hook: 'content-check', line: 1 }, { hook: 'content-check', line: 1 }], [], []]);
  assert.ok(runs.some((run) => run.includes('docs/first.md docs/notes.md')));
  assert.ok(runs.every((run) => !run.includes('docs/first.md') || !run.includes('docs/second.md')));
});

it('checks many staged title and body sets with one process per compatible batch and hook stage', async () => {
  const sets = Array.from({ length: 24 }, (_, at) => {
    const path = `docs/plan-${at}.md`;
    return [new Map([[path, 'Title\n']]), new Map([[path, 'First paragraph.\n']])];
  }).flat();
  const { result, findings, runs } = await checkFileHookSets(sets);
  assert.deepEqual(result, { sets: 48, rejected: 0, unanswered: 0 });
  assert.ok(findings.every((set) => set?.length === 0));
  assert.equal(runs.length, 4);
  for (const run of runs) assert.equal(run.split(' --files ')[1]?.split(' ').length, 24);
});

it('keeps sets isolated when a security hook inherits its alias through a YAML merge', async () => {
  const { result, findings, runs } = await checkFileHookSets([
    new Map([['docs/first.md', 'Safe.\n']]),
    new Map([['docs/second.md', 'Safe.\n']]),
  ], {
    '.pre-commit-config.yaml': FILE_HOOK + `      - <<: { alias: security }
        id: tree-check
        name: Tree check
        language: system
        entry: node tree-check.mjs
        stages: [pre-commit]
`,
    'tree-check.mjs': `import {existsSync} from 'node:fs';
if (existsSync('docs/first.md') && !existsSync('docs/second.md')) process.exitCode = 1;
`,
  });
  assert.deepEqual(result, { sets: 2, rejected: 1, unanswered: 0 });
  assert.deepEqual(findings, [[{ hook: 'security', line: 1 }], []]);
  assert.equal(runs.length, 4);
  assert.ok(runs.every((run) => !run.includes('docs/first.md') || !run.includes('docs/second.md')));
});

it('does not let another set satisfy a candidate interpreted as a Git pathspec', async () => {
  const { result, findings, runs } = await checkFileHookSets([
    new Map([[':(literal)docs/second.md', 'Safe.\n']]),
    new Map([['docs/second.md', 'Safe.\n']]),
  ]);
  assert.deepEqual(result, { sets: 2, rejected: 1, unanswered: 0 });
  assert.deepEqual(findings, [[{ hook: 'security', line: 1 }], []]);
  assert.equal(runs.length, 2);
});

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
  // The gate's scratch folder goes in this fixture's folder, where the canary below would leave its marker.
  const tmp = process.env.TMPDIR;
  process.env.TMPDIR = fixture.root;
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
    // A fixed canary: run as a hook, it writes a marker beside the gate's scratch folder, which this test keeps in its
    // own fixture folder.
    const payload = "import('node:fs').then((fs) => fs.writeFileSync('../hook-canary', 'ran'));\n";
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
  } finally {
    if (tmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = tmp;
    await gate?.close?.();
    await fixture.cleanup();
  }
});

/** A commit on top of `origin/main` that also tracks `entries`, as `git add --force` or a symbolic link would. */
async function trackedWith(git: Git, root: string, entries: {path: string; mode: '100644' | '100755' | '120000' | '160000'; content: string}[]): Promise<string> {
  const env = {GIT_INDEX_FILE: join(root, 'extra.index'), GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com'};
  await git.run(['read-tree', 'origin/main'], {env});
  for (const entry of entries) {
    // A submodule's content is the commit it records.
    const oid = entry.mode === '160000' ? entry.content : await git.text(['hash-object', '-w', '--stdin'], {input: entry.content});
    await git.run(['update-index', '--add', '--cacheinfo', `${entry.mode},${oid},${entry.path}`], {env});
  }
  const tree = await git.text(['write-tree'], {env});
  return git.text(['commit-tree', tree, '-p', 'origin/main', '-m', 'Support files'], {env});
}

// The hook reads the repository's own rule file and refuses a document holding the word it names. It also checks
// that the index holds the tracked tree with only the candidates added, so the hooks check the tree that is merged.
const RULE_HOOK = `import {readFileSync} from 'node:fs'; import {execFileSync} from 'node:child_process';
const files = process.argv.slice(2);
const changed = execFileSync('git', ['diff-index', '--cached', '--name-only', process.env.TRACKED_TREE], {encoding: 'utf8'}).split('\\n').filter(Boolean);
if (changed.some((path) => !files.includes(path))) { console.log('tree differs'); process.exit(2); }
// Like Gitleaks, the hook falls back to its default rules when the repository's rule file is missing.
const rules = (() => { try { return readFileSync('.gitleaks.toml', 'utf8'); } catch { return 'word = "default-rule"'; } })();
const word = rules.match(/word = "(.*)"/)[1];
for (const file of files) if (readFileSync(file, 'utf8').includes(word)) { console.log(file + ':1: custom rule'); process.exitCode = 1; }
`;
const RULE_CONFIG = `repos:
  - repo: local
    hooks:
      - id: custom-rule
        alias: security
        name: Custom rule
        entry: node hooks/rule.mjs
        language: system
        stages: [pre-commit]
`;

it('checks the tracked tree with force-tracked ignored support files and hook scripts', async () => {
  const fixture = await createFixture();
  try {
    await fixture.seed({'.gitignore': '.gitleaks.toml\nignored-hooks/\n', '.pre-commit-config.yaml': RULE_CONFIG, 'hooks/rule.mjs': RULE_HOOK, 'docs/plan.md': 'Original.\n'});
    const git = await fixture.clone('ignored');
    // Ignored by `.gitignore` and tracked all the same, as `git add --force` leaves them: first the rule file alone,
    // then the hook script as well.
    const rules = {path: '.gitleaks.toml', mode: '100644', content: 'word = "house-codename"\n'} as const;
    const ignoredHook = RULE_CONFIG.replace('node hooks/rule.mjs', 'node ignored-hooks/rule.mjs');
    for (const extra of [[rules], [rules, {path: 'ignored-hooks/rule.mjs', mode: '100644', content: RULE_HOOK} as const, {path: '.pre-commit-config.yaml', mode: '100644', content: ignoredHook} as const]]) {
      const tracked = await trackedWith(git, fixture.root, [...extra]);
      const env = {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', TRACKED_TREE: await git.text(['rev-parse', `${tracked}^{tree}`])};
      const gate = await securityGate(git, tracked, {env});
      try {
        assert.deepEqual(await gate.check(new Map([['docs/plan.md', 'Safe.\n']])), []);
        assert.deepEqual(await gate.check(new Map([['docs/plan.md', 'The house-codename.\n']])), [{hook: 'custom-rule', line: 1}]);
        // The ignored files survive the reset between candidates.
        assert.deepEqual(await gate.check(new Map([['docs/new.md', 'The house-codename again.\n']])), [{hook: 'custom-rule', line: 1}]);
        assert.deepEqual(await gate.check(new Map([['docs/new.md', 'Safe.\n']])), []);
      } finally { await gate.close?.(); }
    }
  } finally { await fixture.cleanup(); }
});

it('reproduces a symbolic link that stays in the tree and refuses every candidate when one leads outside it', async () => {
  const fixture = await createFixture();
  try {
    await fixture.seed({'.pre-commit-config.yaml': RULE_CONFIG, 'hooks/rule.mjs': RULE_HOOK, 'config/rules.toml': 'word = "house-codename"\n', 'docs/plan.md': 'Original.\n'});
    const git = await fixture.clone('links');
    const inside = await trackedWith(git, fixture.root, [
      {path: '.gitleaks.toml', mode: '120000', content: 'config/rules.toml'},
      {path: 'docs/alias.md', mode: '120000', content: '../config/rules.toml'},
      // A support file kept as a document, a document alias, and a link to a submodule's folder.
      {path: 'config/extra.toml', mode: '120000', content: '../docs/extra-rules.md'},
      {path: 'docs/extra-rules.md', mode: '100644', content: 'Extra rules.\n'},
      {path: 'README.md', mode: '120000', content: 'docs/plan.md'},
      {path: 'vendor/tool', mode: '160000', content: await git.text(['rev-parse', 'origin/main'])},
      {path: 'tool', mode: '120000', content: 'vendor/tool'},
    ]);
    const env = (tracked: string) => git.text(['rev-parse', `${tracked}^{tree}`]).then((tree) => ({PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', TRACKED_TREE: tree}));
    const gate = await securityGate(git, inside, {env: await env(inside)});
    try {
      assert.deepEqual(await gate.check(new Map([['docs/plan.md', 'Safe.\n']])), []);
      assert.deepEqual(await gate.check(new Map([['docs/plan.md', 'The house-codename.\n']])), [{hook: 'custom-rule', line: 1}]);
      // A candidate at a link's path would be written into its target while the hooks skip the link: refused,
      // whether the link leads to a support file or to a document.
      assert.deepEqual(await gate.check(new Map([['docs/alias.md', 'word = "other"\n']])), [{hook: 'security', line: 1}]);
      assert.deepEqual(await gate.check(new Map([['README.md', 'Safe.\n']])), [{hook: 'security', line: 1}]);
      assert.deepEqual(await gate.check(new Map([['tool/notes.md', 'Safe.\n']])), [{hook: 'security', line: 1}]);
      assert.deepEqual(await gate.check(new Map([['docs/plan.md', 'The house-codename.\n']])), [{hook: 'custom-rule', line: 1}]);
      // The document a support file links to keeps its tracked text; one a document links to is checked as usual.
      assert.deepEqual(await gate.check(new Map([['docs/extra-rules.md', 'Other rules.\n']])), [{hook: 'security', line: 1}]);
      assert.deepEqual(await gate.check(new Map([['docs/plan.md', 'The house-codename.\n']])), [{hook: 'custom-rule', line: 1}]);
    } finally { await gate.close?.(); }
    for (const target of ['../outside.toml', '/etc/hostname', 'config/missing.toml', '.git/config', 'config/../..']) {
      const tracked = await trackedWith(git, fixture.root, [{path: '.gitleaks.toml', mode: '120000', content: target}]);
      const refusing = await securityGate(git, tracked, {env: await env(tracked)});
      try {
        for (let round = 0; round < 2; round++) assert.deepEqual(await refusing.check(new Map([['docs/plan.md', 'Safe.\n']])), [{hook: 'security', line: 1}], target);
      } finally { await refusing.close?.(); }
    }
  } finally { await fixture.cleanup(); }
});

it('keeps a file stored before its LFS pattern as it is stored, with the LFS clean filter on', async () => {
  const fixture = await createFixture();
  const saved = {...process.env};
  let gate: Awaited<ReturnType<typeof securityGate>> | undefined;
  try {
    await fixture.seed({'.pre-commit-config.yaml': RULE_CONFIG, 'hooks/rule.mjs': RULE_HOOK, '.gitleaks.toml': 'word = "house-codename"\n', 'docs/old.png': 'Raw bytes.\n'});
    const git = await fixture.clone('lfs-later');
    // The pattern comes later; the file keeps its raw blob, as it does on a branch that adds the pattern.
    const tracked = await trackedWith(git, fixture.root, [{path: '.gitattributes', mode: '100644', content: '*.png filter=lfs diff=lfs merge=lfs -text\n'}]);
    assert.equal(await git.text(['cat-file', 'blob', `${tracked}:docs/old.png`]), 'Raw bytes.');
    // As on a runner where git-lfs is installed for the user.
    Object.assign(process.env, {GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'filter.lfs.clean', GIT_CONFIG_VALUE_0: 'git-lfs clean -- %f', GIT_CONFIG_KEY_1: 'filter.lfs.smudge', GIT_CONFIG_VALUE_1: 'git-lfs smudge -- %f', GIT_CONFIG_KEY_2: 'filter.lfs.required', GIT_CONFIG_VALUE_2: 'true'});
    gate = await securityGate(git, tracked, {env: {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', TRACKED_TREE: await git.text(['rev-parse', `${tracked}^{tree}`])}});
    assert.deepEqual(await gate.check(new Map([['docs/plan.md', 'Safe.\n']])), []);
    assert.deepEqual(await gate.check(new Map([['docs/plan.md', 'The house-codename.\n']])), [{hook: 'custom-rule', line: 1}]);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    await gate?.close?.();
    await fixture.cleanup();
  }
});

it('gives no answer for a title whose path no gate can take, without naming the path', async () => {
  const TITLE = ['title', 'canary', '5521'].join('-');
  const asked: string[] = [];
  const gate: SecurityGate = {
    configured: true,
    async check(files) {
      asked.push(...files.keys());
      return [];
    },
  };
  // A tracked folder Git accepts that a repository path may not hold: the gate is never asked, and nothing throws with the path.
  for (const path of ['odd\\folder/' + TITLE + '.md', 'docs/../' + TITLE + '.md', 'docs/.git/' + TITLE + '.md']) {
    assert.equal(await checkTitle(gate, path, TITLE), null, path);
  }
  assert.deepEqual(asked, []);
  assert.deepEqual(await checkTitle(gate, 'docs/' + TITLE + '.md', TITLE), []);
  assert.deepEqual(asked, ['docs/' + TITLE + '.md']);
});

const BUDGET_HOOK = `repos:
  - repo: local
    hooks:
      - id: support-check
        alias: security
        name: Support check
        entry: node check.mjs
        language: system
        stages: [pre-commit]
`;

/** Records each `cat-file` call the gate makes on `git`: its arguments, its output cap and the files streamed. */
function spyCatFile(git: Git): { batches: { oids: string[]; maxOutputBytes: number | undefined }[]; streamed: string[] } {
  const batches: { oids: string[]; maxOutputBytes: number | undefined }[] = [];
  const streamed: string[] = [];
  const readBlobs = git.readBlobs.bind(git);
  git.readBlobs = (oids, maxOutputBytes) => {
    // An empty batch reads nothing; a batch reads each id once.
    if (oids.length > 0) batches.push({oids: [...new Set(oids)], maxOutputBytes});
    return readBlobs(oids, maxOutputBytes);
  };
  const runToFile = git.runToFile.bind(git);
  git.runToFile = (args, path, mode) => {
    streamed.push(String(args.at(-1)));
    return runToFile(args, path, mode);
  };
  return {batches, streamed};
}

it('reads support files in byte-bounded batches and streams one larger than a batch, so the hooks still run', async () => {
  const fixture = await createFixture();
  let gate: SecurityGate | undefined;
  try {
    const large: Record<string, Buffer> = {};
    // 32 support files of 1 MiB each: one count-bounded batch of them would exceed the byte budget.
    for (let at = 0; at < 32; at++) large[`assets/part-${at}.bin`] = randomBytes(1024 * 1024);
    const huge = randomBytes(SCRATCH_BATCH_BYTES + 1);
    await fixture.seed({
      '.pre-commit-config.yaml': BUDGET_HOOK,
      // The hook proves the streamed file reached the scratch tree whole.
      'check.mjs': `import {statSync} from 'node:fs'; if (statSync('assets/huge.bin').size !== ${huge.length}) { console.log('docs/plan.md:1: huge'); process.exitCode = 1; } for (const file of process.argv.slice(2)) { if (statSync(file).size === 0) process.exitCode = 1; }`,
      'assets/huge.bin': huge,
      ...large,
    }, {executable: ['assets/part-0.bin']});
    const git = await fixture.clone('large-support');
    const tracked = await git.text(['rev-parse', 'origin/main']);
    const spy = spyCatFile(git);
    gate = await securityGate(git, tracked);
    assert.deepEqual(await gate.check(new Map([['docs/plan.md', 'Safe.\n']])), []);
    const hugeOid = await git.text(['rev-parse', `${tracked}:assets/huge.bin`]);
    assert.deepEqual(spy.streamed, [hugeOid]);
    assert.ok(spy.batches.length >= 2);
    for (const batch of spy.batches) {
      assert.ok(batch.maxOutputBytes !== undefined && batch.maxOutputBytes <= SCRATCH_BATCH_BYTES);
      assert.ok(!batch.oids.includes(hugeOid));
    }
    // Every support file was read, and the scratch tree equals the tracked one (the gate checks this, or it fails).
    const read = new Set(spy.batches.flatMap((batch) => batch.oids));
    for (const path of Object.keys(large)) assert.ok(read.has(await git.text(['rev-parse', `${tracked}:${path}`])));
  } finally { await gate?.close?.(); await fixture.cleanup(); }
});

it('stops a check before any read or hook, with a named code, when the tracked files exceed the scratch budget', async () => {
  const fixture = await createFixture();
  try {
    await fixture.seed({
      '.pre-commit-config.yaml': BUDGET_HOOK,
      // The hook would leave a marker in the real repository's folder if it ever ran.
      'check.mjs': `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(fixture.root, 'hook-ran'))}, '');`,
      'assets/a.bin': randomBytes(64 * 1024),
      'assets/b.bin': randomBytes(64 * 1024),
    });
    const git = await fixture.clone('over-budget');
    const tracked = await git.text(['rev-parse', 'origin/main']);
    const spy = spyCatFile(git);
    // A run with nothing to check is not stopped; the first check is, every time, with the named code.
    const over = await securityGate(git, tracked, {scratchBytes: 100 * 1024});
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(over.check(new Map([['docs/plan.md', 'Safe.\n']])), (error: unknown) =>
          error instanceof SecurityScratchBudgetError && error.code === 'security-scratch-budget' && /security-scratch-budget/.test(error.message));
      }
    } finally { await over.close?.(); }
    // Nothing was read: the budget is checked from the sizes the tree lists.
    assert.deepEqual(spy.batches, []);
    assert.deepEqual(spy.streamed, []);
    await assert.rejects(access(join(fixture.root, 'hook-ran')));
    // Under the budget the same tree is checked as usual.
    const gate = await securityGate(git, tracked, {scratchBytes: 1024 * 1024});
    try {
      assert.deepEqual(await gate.check(new Map([['docs/plan.md', 'Safe.\n']])), []);
    } finally { await gate.close?.(); }
  } finally { await fixture.cleanup(); }
});

/** Whether the folder the gate makes its scratch repository in ignores case, as macOS's default file system does. */
async function tmpIgnoresCase(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'case-probe-'));
  try {
    await writeFile(join(dir, 'probe'), '');
    return await lstat(join(dir, 'PROBE')).then(() => true, () => false);
  } finally { await rm(dir, {recursive: true, force: true}); }
}

it('stops every check with a named code, and blocks no document, when the scratch repository cannot hold the tracked tree', async () => {
  const fixture = await createFixture();
  try {
    await fixture.seed({'.pre-commit-config.yaml': RULE_CONFIG, 'hooks/rule.mjs': RULE_HOOK, '.gitleaks.toml': 'word = "house-codename"\n', 'docs/plan.md': 'Original.\n'});
    const git = await fixture.clone('unreproducible');
    // An empty folder is in the tracked tree, and no working tree keeps one: the scratch tree differs, as it does on
    // a file system that ignores case when two tracked paths differ only by case.
    const emptyTree = await git.text(['mktree'], {input: ''});
    const listing = (await git.text(['ls-tree', 'origin/main'])).split('\n').filter(Boolean);
    const tree = await git.text(['mktree'], {input: [...listing, `040000 tree ${emptyTree}\tempty`].join('\n') + '\n'});
    const tracked = await git.text(['commit-tree', tree, '-p', 'origin/main', '-m', 'Unreproducible tree'], {env: {GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com'}});
    const env = {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', TRACKED_TREE: tree};
    const gate = await securityGate(git, tracked, {env});
    try {
      // Not a finding on the document: the gate has no answer for any, every time it is asked, a safe text included.
      for (const text of ['Safe.\n', 'The house-codename.\n', 'Safe.\n']) {
        await assert.rejects(gate.check(new Map([['docs/plan.md', text]])), (error: unknown) =>
          error instanceof SecurityScratchTreeError && error.code === 'security-scratch-tree' && /^security-scratch-tree: /.test(error.message) && !error.message.includes('plan'));
      }
    } finally { await gate.close?.(); }
  } finally { await fixture.cleanup(); }
});

it('stops a check with a named code where two tracked paths differ only by case and the file system ignores case', async () => {
  const fixture = await createFixture();
  try {
    await fixture.seed({'.pre-commit-config.yaml': RULE_CONFIG, 'hooks/rule.mjs': RULE_HOOK, '.gitleaks.toml': 'word = "house-codename"\n', 'docs/plan.md': 'Original.\n'});
    const git = await fixture.clone('case-collision');
    const tracked = await trackedWith(git, fixture.root, [
      {path: 'docs/collisions/Guide.md', mode: '100644', content: 'Upper.\n'},
      {path: 'docs/collisions/guide.md', mode: '100644', content: 'Lower.\n'},
    ]);
    const env = {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', TRACKED_TREE: await git.text(['rev-parse', `${tracked}^{tree}`])};
    const gate = await securityGate(git, tracked, {env});
    try {
      if (await tmpIgnoresCase()) {
        await assert.rejects(gate.check(new Map([['docs/plan.md', 'Safe.\n']])), SecurityScratchTreeError);
      } else {
        // A file system that keeps both paths checks as usual, and a real finding still blocks.
        assert.deepEqual(await gate.check(new Map([['docs/plan.md', 'Safe.\n']])), []);
        assert.deepEqual(await gate.check(new Map([['docs/plan.md', 'The house-codename.\n']])), [{hook: 'custom-rule', line: 1}]);
      }
    } finally { await gate.close?.(); }
  } finally { await fixture.cleanup(); }
});

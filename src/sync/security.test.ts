import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createFixture } from '../state/test-helpers.ts';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type SecurityGate, checkTitle, securityGate } from './security.ts';
import type { Git } from '../state/index.ts';
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

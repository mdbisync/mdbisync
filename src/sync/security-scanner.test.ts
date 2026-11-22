// The security gate with the scanner hook `init --security-hooks` writes,
// run through pre-commit in the pinned Gitleaks image. Needs Docker; CI has it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { parseDocument } from 'yaml';
import { runCli } from '../cli.ts';
import { SCANNER_IMAGE } from '../init/command.ts';
import { createFixture } from '../state/test-helpers.ts';
import { securityGate } from './security.ts';

// The environment the gate gives its hooks by default, so the probe reaches Docker the way the hook does.
const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' };
const docker = spawnSync('docker', ['info'], { env, stdio: 'ignore' }).status === 0;

/** The hook configuration init writes, keeping only its local security hooks: the others need a released repository. */
async function initSecurityHooks(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'scanner-init-'));
  try {
    await mkdir(join(cwd, '.git'));
    const result = await runCli(['init', '--release-sha', 'a'.repeat(40), '--security-hooks'], { cwd });
    assert.equal(result.exitCode, 0, result.stderr);
    const doc = parseDocument(await readFile(join(cwd, '.pre-commit-config.yaml'), 'utf8'));
    const repos = (doc.toJS() as { repos: Array<{ repo: string }> }).repos;
    for (let at = repos.length - 1; at >= 0; at--) if (repos[at]!.repo !== 'local') doc.deleteIn(['repos', at]);
    return doc.toString();
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

it('rejects a credential in a document whether or not the line carries an inline gitleaks:allow', {
  skip: docker || process.env.CI ? false : 'needs Docker',
  timeout: 600_000,
}, async () => {
  // Pull first: the gate gives a hook run two minutes, which a cold pull could take.
  assert.equal(spawnSync('docker', ['pull', '--quiet', SCANNER_IMAGE], { env, stdio: 'ignore', timeout: 300_000 }).status, 0, 'docker pull');
  const fixture = await createFixture();
  let gate: Awaited<ReturnType<typeof securityGate>> | undefined;
  try {
    await fixture.seed({ '.pre-commit-config.yaml': await initSecurityHooks() });
    const git = await fixture.clone('scanner');
    gate = await securityGate(git, await git.text(['rev-parse', 'origin/main']), { env });
    // A synthetic token of a format Gitleaks knows, built here so no scanner flags this file. Not a PEM key,
    // so only Gitleaks can catch it.
    const token = ['xoxb', '123456789012', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-');
    assert.deepEqual(await gate.check(new Map([['docs/plan.md', '# Plan\n\nNothing secret.\n']])), []);
    for (const line of [`token: ${token} # gitleaks:allow`, `token: ${token}`]) {
      const findings = await gate.check(new Map([['docs/plan.md', `# Plan\n\n${line}\n`]]));
      assert.ok(findings?.some((finding) => finding.hook === 'gitleaks'), `${line.replace(token, '<token>')}: ${JSON.stringify(findings)}`);
    }
  } finally { await gate?.close?.(); await fixture.cleanup(); }
});

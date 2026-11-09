// The setup check's probes against the real services. GitHub: tokens of the
// sync's GitHub App, minted with all of its permissions and with one
// permission taken away, prove that each probe tells the two apart without
// writing. Linear: the run's token resolves existing teams and reports a
// missing one. Read-only on both sides.
//
// Runs only when these are set:
//   MDBISYNC_TEST_GITHUB_APP_ID, MDBISYNC_TEST_GITHUB_APP_KEY_FILE (the App's private key)
//   MDBISYNC_TEST_SANDBOX_REPOSITORY (owner/name, where the App is installed)
//   MDBISYNC_TEST_LINEAR_CLIENT_ID, MDBISYNC_TEST_LINEAR_CLIENT_SECRET
//   MDBISYNC_TEST_LINEAR_TEAMS (comma-separated keys of existing teams)

import assert from 'node:assert/strict';
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { LinearClient, withRunToken, type LogEntry } from '../../src/linear/index.ts';
import { PERMISSION_PROBES, checkGitHub, resolveTargets } from '../../src/setup/index.ts';

const env = process.env;
const appId = env.MDBISYNC_TEST_GITHUB_APP_ID ?? '';
const keyFile = env.MDBISYNC_TEST_GITHUB_APP_KEY_FILE ?? '';
const repository = env.MDBISYNC_TEST_SANDBOX_REPOSITORY ?? '';
const linearId = env.MDBISYNC_TEST_LINEAR_CLIENT_ID ?? '';
const linearSecret = env.MDBISYNC_TEST_LINEAR_CLIENT_SECRET ?? '';
const linearTeams = (env.MDBISYNC_TEST_LINEAR_TEAMS ?? '').split(',').map((team) => team.trim()).filter(Boolean);
const API = 'https://api.github.com';

function appJwt(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 300, iss: appId })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(readFileSync(keyFile, 'utf8')).toString('base64url')}`;
}

async function github(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
}

/** An installation token with the App's permissions, minus `without`. */
async function installationToken(without?: string): Promise<{ token: string; revoke: () => Promise<void> }> {
  const jwt = appJwt();
  const installation = (await (await github(`/repos/${repository}/installation`, jwt)).json()) as { id: number; permissions: Record<string, string> };
  const permissions = { ...installation.permissions };
  if (without !== undefined) {
    const [scope, level] = without.split(':') as [string, string];
    if (level === 'write' && scope !== 'workflows') permissions[scope] = 'read';
    else delete permissions[scope];
  }
  const response = await github(`/app/installations/${installation.id}/access_tokens`, jwt, {
    method: 'POST',
    body: JSON.stringify({ repositories: [repository.split('/')[1]], permissions }),
  });
  const { token } = (await response.json()) as { token: string };
  return { token, revoke: async () => void (await github('/installation/token', token, { method: 'DELETE' })) };
}

describe('setup check against GitHub', { skip: appId && keyFile && repository ? false : 'the GitHub App test variables are not set' }, () => {
  const commit = async (token: string) => ((await (await github(`/repos/${repository}/commits/HEAD`, token)).json()) as { sha: string }).sha;

  it('passes the App token with all its permissions and reads the merge setting', async () => {
    const { token, revoke } = await installationToken();
    try {
      const result = await checkGitHub({ repository, token, commit: await commit(token) });
      assert.equal(result.access.state, 'passed', result.access.detail);
      assert.notEqual(result.mergeCommits.state, 'not-checked', result.mergeCommits.detail);
    } finally {
      await revoke();
    }
  });

  for (const { permission } of PERMISSION_PROBES) {
    it(`names ${permission} when the token lacks it`, async () => {
      const { token, revoke } = await installationToken(permission);
      try {
        const result = await checkGitHub({ repository, token, commit: await commit(token) });
        assert.equal(result.access.code, 'missing-permission');
        const unchecked = permission === 'contents:write' ? ' (workflows:write not checked without it)' : '';
        assert.equal(result.access.detail, `the GitHub token lacks ${permission}${unchecked}`);
      } finally {
        await revoke();
      }
    });
  }
});

describe('setup check against Linear', { skip: linearId && linearSecret && linearTeams.length > 0 ? false : 'the Linear test variables are not set' }, () => {
  it('resolves existing teams and names a missing one, in two requests or fewer', async () => {
    const hooks = { log: (entry: LogEntry) => console.error(JSON.stringify(entry)) };
    await withRunToken({ clientId: linearId, clientSecret: linearSecret }, { hooks, onRevokeError: (error) => assert.fail(String(error)) }, async ({ accessToken, context }) => {
      const client = new LinearClient({ token: accessToken, auth: context, hooks });
      const found = await resolveTargets(client, linearTeams.map((team, index) => ({ team, teamFolder: `t${index}` })));
      assert.equal(found.result.state, 'passed', found.result.detail);
      assert.equal(found.targets?.teams.size, linearTeams.length);
      const missing = await resolveTargets(client, [{ team: 'Nonexistent team 7f3a', teamFolder: 'x' }]);
      assert.equal(missing.result.code, 'annotation-target-not-found');
      assert.match(missing.result.detail, /team "Nonexistent team 7f3a"/);
      assert.ok(client.stats.total <= 2, `${client.stats.total} requests`);
    });
  });
});

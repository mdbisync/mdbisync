// The harness's test configuration: the sandbox repository, Linear's test
// workspace credentials and the GitHub App, from the environment and from a
// `secrets.env` file in the test configuration folder (environment wins).
// Values are secrets: they are never logged or written to a report.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_DIR_ENV = 'MDBISYNC_TEST_CONFIG_DIR';

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[CONFIG_DIR_ENV] || join(homedir(), '.config', 'mdbisync-test');
}

export interface LinearApp {
  /** A neutral label for logs and locks: `app1`, `app2`, ... */
  name: string;
  clientId: string;
  clientSecret: string;
}

export interface TestConfig {
  /** https URL of the sandbox repository. */
  sandboxUrl: string;
  /** Where git reads and pushes; the sandbox URL unless MDBISYNC_TEST_SANDBOX_GIT_URL names a mirror (for trying the harness locally). */
  gitUrl: string;
  owner: string;
  repo: string;
  /** Every OAuth app the secrets list: LINEAR_TEST_APP_CLIENT_ID/SECRET, then LINEAR_TEST_APP_2_..., ... */
  linearApps: LinearApp[];
  editors: { 'editor-a': string; 'editor-b': string };
  /** The GitHub App for local runs, when its key is present. */
  githubApp: { clientId: string; privateKey: string } | null;
  /** What the GitHub App lacks in the test secrets, when it is null. */
  githubAppMissing: string[];
  /** What is missing for a live run; empty when the configuration is complete. */
  missing: string[];
}

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match === null) continue;
    let value = (match[2] as string).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    values[match[1] as string] = value;
  }
  return values;
}

export function parseRepoUrl(url: string): { owner: string; repo: string } | null {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url);
  return match === null ? null : { owner: match[1] as string, repo: match[2] as string };
}

export function loadTestConfig(env: NodeJS.ProcessEnv = process.env): TestConfig {
  const dir = configDir(env);
  const file = join(dir, 'secrets.env');
  const values: Record<string, string | undefined> = { ...(existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {}), ...env };
  const missing: string[] = [];
  const need = (name: string): string => {
    const value = values[name];
    if (value === undefined || value === '') {
      missing.push(name);
      return '';
    }
    return value;
  };

  const sandboxUrl = need('MDBISYNC_TEST_SANDBOX_URL');
  const parsed = sandboxUrl === '' ? null : parseRepoUrl(sandboxUrl);
  if (sandboxUrl !== '' && parsed === null) missing.push('MDBISYNC_TEST_SANDBOX_URL (an https://github.com/<owner>/<repo> URL)');

  const linearApps: LinearApp[] = [];
  for (let index = 1; index <= 9; index += 1) {
    const prefix = index === 1 ? 'LINEAR_TEST_APP' : `LINEAR_TEST_APP_${index}`;
    const clientId = values[`${prefix}_CLIENT_ID`];
    const clientSecret = values[`${prefix}_CLIENT_SECRET`];
    if (clientId && clientSecret) linearApps.push({ name: `app${index}`, clientId, clientSecret });
  }
  if (linearApps.length === 0) missing.push('LINEAR_TEST_APP_CLIENT_ID and LINEAR_TEST_APP_CLIENT_SECRET');

  const editors = { 'editor-a': need('LINEAR_TEST_ALICE_API_KEY'), 'editor-b': need('LINEAR_TEST_BOB_API_KEY') };

  const keyFile = values['SYNC_APP_PRIVATE_KEY_FILE'] || join(dir, 'sync-app.pem');
  const privateKey = values['SYNC_APP_PRIVATE_KEY'] || (existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : '');
  const clientId = values['SYNC_APP_CLIENT_ID'] || '';
  const githubApp = privateKey !== '' && clientId !== '' ? { clientId, privateKey } : null;
  const githubAppMissing = [...(clientId === '' ? ['SYNC_APP_CLIENT_ID'] : []), ...(privateKey === '' ? ['the App private key'] : [])];

  const gitUrl = values['MDBISYNC_TEST_SANDBOX_GIT_URL'] || sandboxUrl;
  return { sandboxUrl, gitUrl, owner: parsed?.owner ?? '', repo: parsed?.repo ?? '', linearApps, editors, githubApp, githubAppMissing, missing };
}

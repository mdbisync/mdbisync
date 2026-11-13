// Canary shared by the live Actions fixture and the offline release smoke.
// Only processes carrying this workflow run id are compared with its secrets.
export const CANARY_ENABLED = 'MDBISYNC_SECURITY_CANARY';
export const CANARY_HOOK_STEP = 'Run the security hooks';
export const CANARY_FIXTURE = 'actions-security-canary';
export const CANARY_KEY_ENV = 'MDBISYNC_TEST_HOOK_KEY';
export const CANARY_KEY = 'CANARY_HOOK_KEY';
export const CANARY_TOKEN_OBSERVER_FILE = 'security-token-observer.mjs';
export const CANARY_FILE = 'security-canary.mjs';
export const CANARY_PREFIX = 'Security canary: ';
export const CANARY_EVIDENCE = 'security-canary.jsonl';
export const CANARY_BASELINE = 'security-canary-baseline.json';

/** The stage step's environment names that carry the run's own secrets to the token observer. */
export const CANARY_SECRET_INPUTS = ['CANARY_LINEAR_SECRET', 'CANARY_APP_TOKEN'] as const;

/**
 * The canary's pre-commit hook. A runner need not have `node` on its PATH,
 * so in the sync's hooks step it runs on the Node the stage step named for
 * that step. Elsewhere (the pull request's pre-commit check, a person's
 * commit) that name is unset and the hook takes `node` from PATH, where it
 * exits at once without the canary flag.
 */
export const CANARY_HOOK_ENTRY = `sh -c 'exec "\${MDBISYNC_NODE:-node}" ${CANARY_FILE}'`;

/**
 * Loaded through NODE_OPTIONS only in the credential-bearing stage process,
 * so it runs on the action's own Node. Its first load writes the baseline of
 * the run's own secrets; then it adds each minted Linear token. It retains
 * digests only and leaves the secrets out of the environment of any process
 * the stage starts.
 */
export const CANARY_TOKEN_OBSERVER = `import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const secrets = ${JSON.stringify(CANARY_SECRET_INPUTS)};
const baselineFile = join(process.env.RUNNER_TEMP, '${CANARY_BASELINE}');
if (!existsSync(baselineFile)) {
  if (secrets.some(name => !process.env[name])) throw new Error('Missing canary baseline input');
  const digest = value => createHash('sha256').update(value).digest('hex');
  try {
    writeFileSync(baselineFile, JSON.stringify(secrets.map(name => ({ hash: digest(process.env[name]), length: process.env[name].length }))), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    // Another process of the stage step wrote it first.
    if (error.code !== 'EEXIST') throw error;
  }
}
for (const name of secrets) delete process.env[name];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  const request = args[0];
  const url = new URL(typeof request === 'string' || request instanceof URL ? request : request.url);
  if (url.pathname.endsWith('/oauth/token') && response.ok) {
    const body = await response.clone().json();
    if (typeof body.access_token === 'string' && body.access_token.length > 0) {
      const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
      baseline.push({ hash: createHash('sha256').update(body.access_token).digest('hex'), length: body.access_token.length });
      writeFileSync(baselineFile, JSON.stringify(baseline), { mode: 0o600 });
    }
  }
  return response;
};
`;

/** No secret values, hashes, command lines or process metadata reach the log. */
export function canaryScript(keyDigest: string): string {
  if (!/^[0-9a-f]{64}$/.test(keyDigest)) throw new Error('Invalid hook key digest');
  return `if (process.env.${CANARY_ENABLED} !== '1') process.exit(0);
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const digest = value => createHash('sha256').update(value).digest('hex');
const baseline = JSON.parse(readFileSync(join(process.env.RUNNER_TEMP, '${CANARY_BASELINE}'), 'utf8'));
if (!Array.isArray(baseline) || baseline.length < 3 || !baseline.every(value => /^[0-9a-f]{64}$/.test(value.hash) && Number.isSafeInteger(value.length) && value.length > 0)) throw new Error('Invalid canary baseline');
const matched = baseline.map(() => false);
const run = process.env.GITHUB_RUN_ID;
if (!run || !readFileSync('/proc/self/environ', 'utf8').split('\\0').includes('GITHUB_RUN_ID=' + run)) throw new Error('Cannot read own workflow environment');
for (const pid of readdirSync('/proc')) {
  if (!/^[0-9]+$/.test(pid)) continue;
  let env;
  try { env = readFileSync('/proc/' + pid + '/environ', 'utf8').split('\\0'); } catch { continue; }
  if (!env.includes('GITHUB_RUN_ID=' + run)) continue;
  // Compare complete environment values, never print them.
  const values = env.map(entry => entry.slice(entry.indexOf('=') + 1));
  try { values.push(...readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\0')); } catch {}
  for (const value of [...values]) {
    try { values.push(decodeURIComponent(value)); } catch {}
    for (const match of value.matchAll(/basic\\s+([a-z0-9+/]+=*)/gi)) values.push(Buffer.from(match[1], 'base64').toString('utf8'));
  }
  for (let index = 0; index < baseline.length; index++) {
    const { hash, length } = baseline[index];
    matched[index] ||= values.some(value => {
      for (let at = 0; at <= value.length - length; at++) if (digest(value.slice(at, at + length)) === hash) return true;
      return false;
    });
  }
}
const facts = { environmentNames: Object.keys(process.env).sort(), hookKeyMatches: digest(process.env.${CANARY_KEY} ?? '') === '${keyDigest}', linearSecretMatches: matched[0], linearTokenMatches: matched.slice(2).some(Boolean), appTokenMatches: matched[1] };
mkdirSync(join(process.env.RUNNER_TEMP, 'mdbisync-report'), { recursive: true });
appendFileSync(join(process.env.RUNNER_TEMP, 'mdbisync-report', '${CANARY_EVIDENCE}'), '${CANARY_PREFIX}' + JSON.stringify(facts) + '\\n', { mode: 0o600 });
if (!facts.hookKeyMatches || matched.some(Boolean)) process.exitCode = 1;
`;
}

export interface CanaryFacts {
  environmentNames: string[];
  hookKeyMatches: boolean;
  linearSecretMatches: boolean;
  linearTokenMatches: boolean;
  appTokenMatches: boolean;
}

/** Ignore runner log prefixes, but accept only the canary's exact facts. */
export function canaryFacts(log: string): CanaryFacts[] {
  return log.split('\n').flatMap(line => {
    const at = line.indexOf(CANARY_PREFIX);
    if (at < 0) return [];
    try {
      const value = JSON.parse(line.slice(at + CANARY_PREFIX.length)) as CanaryFacts;
      if (Object.keys(value).sort().join(',') !== 'appTokenMatches,environmentNames,hookKeyMatches,linearSecretMatches,linearTokenMatches' || !Array.isArray(value.environmentNames) || !value.environmentNames.every(name => typeof name === 'string' && !/[=\0\r\n]/.test(name) && name.length > 0) || ![value.hookKeyMatches, value.linearSecretMatches, value.linearTokenMatches, value.appTokenMatches].every(flag => typeof flag === 'boolean')) return [];
      return [value];
    } catch { return []; }
  });
}

/**
 * Runner variables named `ACTIONS_*` that carry no credential and may reach
 * the hooks step. The runner sets `ACTIONS_ORCHESTRATION_ID` on every step:
 * a correlation id that `actions/checkout` puts into git's user agent. The
 * list is exact on purpose: other `ACTIONS_*` names carry tokens or the
 * service URLs those tokens open (`ACTIONS_RUNTIME_TOKEN`,
 * `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_URL`,
 * `ACTIONS_CACHE_URL`, `ACTIONS_RESULTS_URL`), and a name the runner adds
 * later fails isolation until someone has checked it and named it here.
 */
const ALLOWED_ACTIONS_NAMES: ReadonlySet<string> = new Set(['ACTIONS_ORCHESTRATION_ID']);

/** Whether an environment name in the hooks step breaks isolation: the stage's secrets, action inputs, unlisted runner variables. */
export function canaryNameLeaks(name: string): boolean {
  if ((CANARY_SECRET_INPUTS as readonly string[]).includes(name) || name.startsWith('INPUT_')) return true;
  return name.startsWith('ACTIONS_') && !ALLOWED_ACTIONS_NAMES.has(name);
}

/** The same pass condition for live evidence and the offline workflow smoke. */
export function canaryIsolated(fact: CanaryFacts): boolean {
  return fact.hookKeyMatches && !fact.linearSecretMatches && !fact.linearTokenMatches && !fact.appTokenMatches
    && !fact.environmentNames.some(canaryNameLeaks);
}

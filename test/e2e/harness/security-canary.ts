// Canary shared by the live Actions fixture and the offline release smoke.
// Only processes carrying this workflow run id are compared with its secrets.
export const CANARY_FIXTURE = 'actions-security-canary';
export const CANARY_KEY_ENV = 'MDBISYNC_TEST_HOOK_KEY';
export const CANARY_KEY = 'CANARY_HOOK_KEY';
export const CANARY_FILE = 'security-canary.mjs';
export const CANARY_PREFIX = 'Security canary: ';
export const CANARY_EVIDENCE = 'security-canary.jsonl';
export const CANARY_BASELINE = 'security-canary-baseline.json';

/** Runs in a credential-bearing step before stage, never in the hooks step. */
export const CANARY_PREPARE = `node --input-type=module <<'NODE'
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const digest = value => createHash('sha256').update(value).digest('hex');
const secrets = ['CANARY_LINEAR_SECRET', 'CANARY_APP_TOKEN'];
if (secrets.some(name => !process.env[name])) throw new Error('Missing canary baseline input');
writeFileSync(join(process.env.RUNNER_TEMP, '${CANARY_BASELINE}'), JSON.stringify(secrets.map(name => digest(process.env[name]))), { mode: 0o600 });
NODE`;

/** No secret values, hashes, command lines or process metadata reach the log. */
export function canaryScript(keyDigest: string): string {
  if (!/^[0-9a-f]{64}$/.test(keyDigest)) throw new Error('Invalid hook key digest');
  return `import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const digest = value => createHash('sha256').update(value).digest('hex');
const baseline = JSON.parse(readFileSync(join(process.env.RUNNER_TEMP, '${CANARY_BASELINE}'), 'utf8'));
if (!Array.isArray(baseline) || baseline.length !== 2 || !baseline.every(value => /^[0-9a-f]{64}$/.test(value))) throw new Error('Invalid canary baseline');
const matched = [false, false];
let linearTokenMatches = false;
const run = process.env.GITHUB_RUN_ID;
if (!run || !readFileSync('/proc/self/environ', 'utf8').split('\\0').includes('GITHUB_RUN_ID=' + run)) throw new Error('Cannot read own workflow environment');
for (const pid of readdirSync('/proc')) {
  if (!/^[0-9]+$/.test(pid)) continue;
  let env;
  try { env = readFileSync('/proc/' + pid + '/environ', 'utf8').split('\\0'); } catch { continue; }
  if (!env.includes('GITHUB_RUN_ID=' + run)) continue;
  // A Linear access token has no baseline before stage mints it. Detect its
  // credential environment fields only in this workflow run.
  linearTokenMatches ||= env.some(entry => /^[^=]*LINEAR[^=]*TOKEN[^=]*=.+/i.test(entry));
  // Compare complete environment values, never print them.
  const values = env.map(entry => entry.slice(entry.indexOf('=') + 1));
  try { values.push(...readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\0')); } catch {}
  for (let index = 0; index < baseline.length; index++) {
    matched[index] ||= values.some(value => digest(value) === baseline[index]);
  }
}
const facts = { environmentNames: Object.keys(process.env).sort(), hookKeyMatches: digest(process.env.${CANARY_KEY} ?? '') === '${keyDigest}', linearSecretMatches: matched[0], linearTokenMatches, appTokenMatches: matched[1] };
mkdirSync(join(process.env.RUNNER_TEMP, 'mdbisync-report'), { recursive: true });
appendFileSync(join(process.env.RUNNER_TEMP, 'mdbisync-report', '${CANARY_EVIDENCE}'), '${CANARY_PREFIX}' + JSON.stringify(facts) + '\\n', { mode: 0o600 });
if (!facts.hookKeyMatches || linearTokenMatches || matched.some(Boolean)) process.exitCode = 1;
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
      if (Object.keys(value).sort().join(',') !== 'appTokenMatches,environmentNames,hookKeyMatches,linearSecretMatches,linearTokenMatches' || !Array.isArray(value.environmentNames) || !value.environmentNames.every(name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) || ![value.hookKeyMatches, value.linearSecretMatches, value.linearTokenMatches, value.appTokenMatches].every(flag => typeof flag === 'boolean')) return [];
      return [value];
    } catch { return []; }
  });
}

import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { LINEAR_TOKEN_STATE } from '../../../src/action/state.ts';
import { postEntry } from './engine.ts';

const REVOKED = "post: revoked the run's Linear token";

/**
 * Keep the proxy's event loop free while post revokes every observed orphan.
 * Give only tokens not revoked yet: Linear answers 401 to a second revocation.
 * An unconfirmed revocation is tried once more, after `retryDelayMs`, before it fails cleanup.
 */
export async function cleanupKilledTokens(tokens: readonly string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; linearUrl: string; retryDelayMs?: number;
}): Promise<string> {
  let output = '';
  for (const token of tokens) {
    const post = async () => {
      const result = await promisify(execFile)(process.execPath, [postEntry()], {
        cwd: options.cwd,
        env: { ...options.env, [`STATE_${LINEAR_TOKEN_STATE}`]: token, 'INPUT_LINEAR-API-URL': options.linearUrl },
        encoding: 'utf8', timeout: 35_000,
      });
      // File commands are consumed by the runner, but this child runs outside it.
      // Never retain a raw mask command or token in the harness evidence.
      const text = `${result.stdout}${result.stderr}`.replace(/^::add-mask::.*(?:\r?\n|$)/gm, '').split(token).join('[masked]');
      // Post intentionally exits successfully on revocation errors to preserve a
      // job's result. Cleanup needs its positive confirmation before releasing a run.
      return { text, confirmed: result.stdout.split(/\r?\n/).includes(REVOKED) };
    };
    let attempt = await post();
    if (!attempt.confirmed) {
      await delay(options.retryDelayMs ?? 2_000);
      attempt = await post();
    }
    if (!attempt.confirmed) {
      const reason = /^::warning::(.*)$/m.exec(attempt.text)?.[1];
      throw new Error(`token revocation was not confirmed${reason === undefined ? '' : ` (${reason})`}`);
    }
    output += attempt.text;
  }
  return output;
}

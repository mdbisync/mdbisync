import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { LINEAR_TOKEN_STATE } from '../../../src/action/state.ts';
import { postEntry } from './engine.ts';
import { tokenActive } from './subjects.ts';

const REVOKED = "post: revoked the run's Linear token";

/** A workflow command's data as written, without the percent-encoding `@actions/core` gives it. */
function commandData(value: string): string {
  return value.replace(/%0D/g, '\r').replace(/%0A/g, '\n').replace(/%25/g, '%');
}

/**
 * Keep the proxy's event loop free while post revokes every observed orphan.
 * Give only tokens not revoked yet: Linear answers 401 to a second revocation.
 * A revocation post does not confirm counts as done when the token no longer works
 * (it was revoked already, or the answer was lost); otherwise post tries it once more,
 * after `retryDelayMs`, before the token fails cleanup.
 */
export async function cleanupKilledTokens(tokens: readonly string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; linearUrl: string; retryDelayMs?: number;
}): Promise<string> {
  const pauseMs = options.retryDelayMs ?? 2_000;
  let output = '';
  for (const token of tokens) {
    // File commands are consumed by the runner, but this child runs outside it.
    // Never retain a raw mask command or token in the harness evidence.
    const masked = (text: string) => text.replace(/^::add-mask::.*(?:\r?\n|$)/gm, '').split(token).join('[masked]');
    const post = async (): Promise<{ text: string; confirmed: boolean; reason: string | undefined }> => {
      try {
        const result = await promisify(execFile)(process.execPath, [postEntry()], {
          cwd: options.cwd,
          env: { ...options.env, [`STATE_${LINEAR_TOKEN_STATE}`]: token, 'INPUT_LINEAR-API-URL': options.linearUrl },
          encoding: 'utf8', timeout: 35_000,
        });
        const text = masked(`${result.stdout}${result.stderr}`);
        const warning = /^::warning::(.*?)\r?$/m.exec(text)?.[1];
        // Post intentionally exits successfully on revocation errors to preserve a
        // job's result. Cleanup needs its positive confirmation before releasing a run.
        return { text, confirmed: result.stdout.split(/\r?\n/).includes(REVOKED), reason: warning === undefined ? undefined : commandData(warning).replace(/\s*\r?\n\s*/g, ' ') };
      } catch (error) {
        // A post that timed out, crashed or exited non-zero confirmed nothing either.
        const reason = masked((error as Error).message).split(/\r?\n/)[0];
        return { text: `post did not finish: ${reason}\n`, confirmed: false, reason };
      }
    };
    let reason: string | undefined;
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt += 1) {
      if (attempt > 0) await delay(pauseMs);
      const result = await post();
      output += result.text;
      reason = result.reason;
      done = result.confirmed || !(await tokenActive(token, fetch, pauseMs, options.linearUrl));
      if (done && !result.confirmed) output += 'cleanup: the token no longer works, so it counts as revoked\n';
    }
    if (!done) throw new Error(`token revocation was not confirmed${reason === undefined ? '' : ` (${reason})`}`);
  }
  return output;
}

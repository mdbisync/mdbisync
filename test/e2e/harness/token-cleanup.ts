import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LINEAR_TOKEN_STATE } from '../../../src/action/state.ts';
import { postEntry } from './engine.ts';

/** Keep the proxy's event loop free while post revokes every observed orphan. */
export async function cleanupKilledTokens(tokens: readonly string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; linearUrl: string;
}): Promise<string> {
  let output = '';
  for (const token of tokens) {
    const result = await promisify(execFile)(process.execPath, [postEntry()], {
      cwd: options.cwd,
      env: { ...options.env, [`STATE_${LINEAR_TOKEN_STATE}`]: token, 'INPUT_LINEAR-API-URL': options.linearUrl },
      encoding: 'utf8', timeout: 35_000,
    });
    // File commands are consumed by the runner, but this child runs outside it.
    // Never retain a raw mask command or token in the harness evidence.
    output += `${result.stdout}${result.stderr}`.replace(/^::add-mask::.*(?:\r?\n|$)/gm, '').split(token).join('[masked]');
  }
  return output;
}

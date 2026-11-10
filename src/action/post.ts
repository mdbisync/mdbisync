// GitHub Action `post` step. It runs after every other step of the job, also
// when the job failed or was cancelled. `main` revokes the run's Linear token
// itself; when it could not (the step was killed, or the revocation failed),
// the token is still in the step's state and this step revokes it.

import * as core from "@actions/core";
import { revokeToken } from "../linear/index.ts";
import { LINEAR_TOKEN_STATE } from "./state.ts";
import { message } from "../messages.ts";

export interface PostOptions {
  /** For tests: the fake Linear. */
  fetch?: typeof fetch;
}

export async function run(options: PostOptions = {}): Promise<void> {
  const token = core.getState(LINEAR_TOKEN_STATE);
  if (token === "") {
    core.info("post: no Linear token left to revoke");
    return;
  }
  core.setSecret(token);
  const apiUrl = core.getInput("linear-api-url").trim();
  try {
    await revokeToken(token, { ...(apiUrl === "" ? {} : { baseUrl: apiUrl }), ...(options.fetch ? { fetch: options.fetch } : {}) });
    core.info("post: revoked the run's Linear token");
  } catch (error) {
    // Linear expires the token on its own; the job's result stays the main step's.
    core.warning(message('action.post-revoke-failed', { reason: error instanceof Error ? error.message : String(error) }));
  }
}

if (import.meta.main) {
  await run();
}

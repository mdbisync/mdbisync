// GitHub Action `post` step. It runs after `main` even when the job fails or
// is cancelled; it will revoke the run's Linear token. Nothing to do yet.

import * as core from "@actions/core";

export function run(): void {
  core.info("post: not implemented, nothing to clean up");
}

if (import.meta.main) {
  run();
}

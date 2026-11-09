import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { OPERATIONS, parseOperation } from "./main.ts";

test("the operation input defaults to sync and accepts both entry points", () => {
  assert.equal(parseOperation(""), "sync");
  assert.equal(parseOperation("  initial-sync "), "initial-sync");
  assert.deepEqual(OPERATIONS, ["sync", "initial-sync"]);
  assert.throws(() => parseOperation("lint"), /unknown operation: lint/);
});

test("action.yml runs the bundled main and post steps on node24", () => {
  const actionYml = readFileSync("action.yml", "utf8");
  assert.match(actionYml, /^\s+using: node24$/m);
  assert.match(actionYml, /^\s+main: dist\/action-main\.js$/m);
  assert.match(actionYml, /^\s+post: dist\/action-post\.js$/m);
  // The post step revokes a token left behind by a failed or cancelled run.
  assert.match(actionYml, /^\s+post-if: always\(\)$/m);
});

const required = process.env["CI"] === "true";

for (const entry of [
  { label: "source", main: "src/action/main.ts", post: "src/action/post.ts", required: true },
  { label: "bundle", main: "dist/action-main.js", post: "dist/action-post.js", required },
]) {
  test(`the ${entry.label} action steps need their inputs, and post has no token to revoke`, (t) => {
    if (!entry.required && !existsSync(entry.main)) {
      t.skip("not built; run `npm run build` first");
      return;
    }
    // Clear the runner's command files so @actions/core writes to stdout.
    const baseEnv = { ...process.env, GITHUB_OUTPUT: "", GITHUB_STATE: "", GITHUB_STEP_SUMMARY: "" };
    for (const operation of OPERATIONS) {
      const child = spawnSync(process.execPath, [entry.main], { encoding: "utf8", env: { ...baseEnv, INPUT_OPERATION: operation } });
      assert.equal(child.status, 1, `${entry.main} ${operation}`);
      assert.match(child.stdout, /::error::the input linear-client-id is required/);
    }
    const post = spawnSync(process.execPath, [entry.post], { encoding: "utf8", env: baseEnv });
    assert.equal(post.status, 0);
    assert.match(post.stdout, /post: no Linear token left to revoke/);
  });
}

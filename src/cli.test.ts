import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { COMMANDS, IMPLEMENTED, PREFLIGHT_COMMANDS, USAGE_EXIT_CODE, type CommandName } from "./commands.ts";
import { runCli } from "./cli.ts";
import { VERSION } from "./version.ts";

const commandNames = Object.keys(COMMANDS);
const stubNames = commandNames.filter((name) => !IMPLEMENTED.has(name as CommandName) && !(PREFLIGHT_COMMANDS as readonly string[]).includes(name));
/** An environment without any MDBISYNC_* input. */
const bareEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MDBISYNC_") && key !== "GITHUB_REPOSITORY"));

test("every command has its own non-zero exit code", () => {
  const codes: number[] = Object.values(COMMANDS).map((info) => info.notImplementedExitCode);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) {
    assert.ok(code !== 0 && code !== 1 && code !== USAGE_EXIT_CODE, `exit code ${code} is reserved`);
  }
});

test("the command set is the documented one", () => {
  assert.deepEqual(commandNames, ["sync", "initial-sync", "lint", "fix", "init", "check"]);
});

for (const name of stubNames) {
  test(`${name} prints "not implemented" with its exit code`, async () => {
    const result = await runCli([name]);
    assert.equal(result.stderr, `${name}: not implemented\n`);
    assert.equal(result.stdout, "");
    assert.equal(result.exitCode, COMMANDS[name as keyof typeof COMMANDS].notImplementedExitCode);
  });
}

for (const name of PREFLIGHT_COMMANDS) {
  test(`${name} without its inputs names the missing input and exits with the usage code`, async () => {
    const result = await runCli([name], { env: bareEnv });
    assert.equal(result.exitCode, USAGE_EXIT_CODE);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`^${name}: the input `));
  });
}

test("--version prints the package version", async () => {
  assert.deepEqual(await runCli(["--version"]), { exitCode: 0, stdout: `${VERSION}\n`, stderr: "" });
});

test("an unknown or missing command prints usage and exits with the usage code", async () => {
  for (const args of [[], ["nope"]]) {
    const result = await runCli(args);
    assert.equal(result.exitCode, USAGE_EXIT_CODE);
    assert.match(result.stderr, /Usage: mdbisync <command>/);
  }
});

// The same contract through real processes: the TypeScript source and, once
// built, the bundle that users run. CI builds first, so there the bundle
// must exist.
const entries = [
  { label: "source", file: "src/cli.ts", required: true },
  { label: "bundle", file: "dist/cli.js", required: process.env["CI"] === "true" },
];

for (const entry of entries) {
  test(`the ${entry.label} entry behaves as a process`, (t) => {
    if (!entry.required && !existsSync(entry.file)) {
      t.skip("not built; run `npm run build` first");
      return;
    }
    for (const name of stubNames) {
      const child = spawnSync(process.execPath, [entry.file, name], { encoding: "utf8" });
      assert.equal(child.status, COMMANDS[name as keyof typeof COMMANDS].notImplementedExitCode, `${entry.file} ${name}`);
      assert.equal(child.stderr, `${name}: not implemented\n`);
    }
    for (const name of PREFLIGHT_COMMANDS) {
      const child = spawnSync(process.execPath, [entry.file, name], { encoding: "utf8", env: bareEnv });
      assert.equal(child.status, USAGE_EXIT_CODE, `${entry.file} ${name}`);
      assert.match(child.stderr, /the input linear-client-id is required/);
    }
    assert.equal(execFileSync(process.execPath, [entry.file, "--version"], { encoding: "utf8" }), `${VERSION}\n`);
    // The bundle is the package's `bin`, so it must start with a Node shebang.
    assert.ok(readFileSync(entry.file, "utf8").startsWith("#!/usr/bin/env node\n"), `${entry.file} lacks the shebang`);
  });
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

for (const file of ['pre-commit.yml', 'mdbisync.yml', 'mdbisync-initial-sync.yml']) {
  const workflow = parse(readFileSync(new URL(`../../examples/${file}`, import.meta.url), 'utf8'));
  const steps = Object.values(workflow.jobs).flatMap(job => (job as { steps: { name?: string; run?: string }[] }).steps);
  const script = steps.find(step => step.name === 'Install pre-commit')!.run!;
  for (const mode of ['installed', 'missing-python', 'missing-venv', 'install', 'pip-failure']) {
    test(`${file}: pre-commit setup with ${mode} and no pipx`, () => {
      const root = mkdtempSync(join(tmpdir(), 'pre-commit-install-'));
      try {
        const bin = join(root, 'bin');
        mkdirSync(bin);
        const executable = (name: string, source: string) => {
          writeFileSync(join(bin, name), `#!/bin/bash\n${source}\n`);
          chmodSync(join(bin, name), 0o755);
        };
        executable('mktemp', 'exec /usr/bin/mktemp "$@"');
        if (mode === 'installed') executable('pre-commit', 'exit 0');
        else if (mode !== 'missing-python') executable('python3', mode === 'missing-venv' ? 'exit 1' : `
          [ "$1 $2" = '-m venv' ] || exit 2
          /bin/mkdir -p "$3/bin"
          /bin/cat > "$3/bin/python" <<'PYTHON'
#!/bin/bash
[ "$*" = '-m pip install pre-commit==4.6.2' ] || exit 2
exit ${mode === 'pip-failure' ? 7 : 0}
PYTHON
          /bin/chmod +x "$3/bin/python"
        `);
        const output = join(root, 'github-path');
        writeFileSync(output, '');
        const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
          env: { PATH: bin, RUNNER_TEMP: root, GITHUB_PATH: output }, encoding: 'utf8',
        });
        if (mode === 'install') {
          assert.equal(result.status, 0, result.stderr);
          assert.match(readFileSync(output, 'utf8'), new RegExp(`^${root}/pre-commit\\.[^/]+/bin\\n$`));
        } else if (mode === 'installed') {
          assert.equal(result.status, 0, result.stderr);
          assert.equal(readFileSync(output, 'utf8'), '');
        } else {
          assert.notEqual(result.status, 0);
          assert.equal(readFileSync(output, 'utf8'), '');
          if (mode !== 'pip-failure') assert.match(result.stdout, /::error::.*Python 3.*venv.*pre-commit on PATH/);
          else assert.equal(result.status, 7);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

for (const file of ['pre-commit.yml', 'mdbisync.yml', 'mdbisync-initial-sync.yml']) {
  const workflow = parse(readFileSync(new URL(`../../examples/${file}`, import.meta.url), 'utf8'));
  const steps = Object.values(workflow.jobs).flatMap(job => (job as { steps: { name?: string; run?: string }[] }).steps);
  const script = steps.find(step => step.name === 'Install pre-commit')!.run!;
  for (const mode of ['installed', 'old-version', 'missing-python', 'old-python', 'missing-venv', 'install', 'pip-failure']) {
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
        executable('mkdir', 'exec /bin/mkdir "$@"');
        executable('ln', 'exec /bin/ln "$@"');
        if (mode === 'installed' || mode === 'old-version') executable('pre-commit', `echo 'pre-commit ${mode === 'installed' ? '4.6.2' : '2.0.0'}'`);
        if (mode !== 'missing-python') executable('python3', `
          # The version check runs first: 3.10 is too old for the pinned list.
          if [ "$1" = -c ]; then [ "$2" = 'import sys; sys.exit(sys.version_info < (3, 11))' ] || exit 2; exit ${mode === 'old-python' ? 1 : 0}; fi
          if [ "$1" = -V ]; then echo 'Python 3.10.12'; exit 0; fi
          ${mode === 'missing-venv' ? 'exit 1' : ''}
          [ "$1 $2" = '-m venv' ] || exit 2
          /bin/mkdir -p "$3/bin"
          /bin/cat > "$3/bin/python" <<'PYTHON'
#!/bin/bash
[ "$*" = '-m pip install --require-hashes --only-binary :all: -r /dev/stdin' ] || exit 2
# The requirements arrive on standard input, pinned with hashes.
/bin/grep -q '^pre-commit==4\\.6\\.2 --hash=sha256:[0-9a-f]\\{64\\}$' || exit 3
${mode === 'pip-failure' ? 'exit 7' : `
/bin/cat > "$(/usr/bin/dirname "$0")/pre-commit" <<'PRECOMMIT'
#!/bin/bash
echo 'pre-commit 4.6.2'
PRECOMMIT
/bin/chmod +x "$(/usr/bin/dirname "$0")/pre-commit"`}
PYTHON
          /bin/chmod +x "$3/bin/python"
        `);
        const output = join(root, 'github-path');
        writeFileSync(output, '');
        const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
          env: { PATH: bin, RUNNER_TEMP: root, GITHUB_PATH: output }, encoding: 'utf8',
        });
        if (mode === 'install' || (mode === 'old-version' && file === 'pre-commit.yml')) {
          assert.equal(result.status, 0, result.stderr);
          const commands = readFileSync(output, 'utf8').trim();
          assert.equal(dirname(dirname(commands)), root);
          assert.ok(commands.endsWith('/commands'));
          const next = spawnSync('/bin/bash', ['-c', 'pre-commit --version; command -v python3'], {
            env: { PATH: `${commands}:${bin}` }, encoding: 'utf8',
          });
          assert.equal(next.status, 0, next.stderr);
          assert.equal(next.stdout, `pre-commit 4.6.2\n${bin}/python3\n`);
        } else if (mode === 'installed' || mode === 'old-version') {
          assert.equal(result.status, 0, result.stderr);
          assert.equal(readFileSync(output, 'utf8'), '');
        } else {
          assert.notEqual(result.status, 0);
          assert.equal(readFileSync(output, 'utf8'), '');
          if (mode === 'old-python') {
            assert.equal(result.stdout, '::error::Python 3.11 or later is required, found Python 3.10.12; install it, or provide pre-commit on PATH.\n');
            assert.deepEqual(readdirSync(root).filter(name => name.startsWith('pre-commit.')), [], 'nothing is installed');
          } else if (mode !== 'pip-failure') assert.match(result.stdout, /::error::.*Python 3.*venv.*pre-commit on PATH/);
          else assert.match(result.stdout, /::error::.*Python 3\.11 to 3\.14.*PyPI/);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

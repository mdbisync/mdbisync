// Hook output is untrusted: retain only configured hook ids and line numbers.
// Candidate content is written to a disposable directory, never to the repository being synchronized.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Git, type Oid, listTree, readBlobs, checkRepoPath } from '../state/index.ts';
import { readHookConfig, PRE_COMMIT_CONFIG, SECURITY_ALIAS } from '../setup/hooks.ts';

export interface SecurityFinding { hook: string; line: number }
export interface SecurityGate {
  readonly configured: boolean;
  check(files: ReadonlyMap<string, Buffer | string>): Promise<SecurityFinding[]>;
}

/** Captures stdout and stderr privately; neither errors nor returned findings contain raw output. */
function runHooks(dir: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn('pre-commit', args, { cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', PRE_COMMIT_COLOR: 'never', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer) => { if (output.length < 2_000_000) output += chunk.toString('utf8'); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, output: '' }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, output }); });
  });
}

/** Uses the tracked branch's configuration and supporting files, never a Linear-supplied config. */
export async function securityGate(git: Git, tracked: Oid): Promise<SecurityGate> {
  const read = await git.run(['cat-file', 'blob', `${tracked}:${PRE_COMMIT_CONFIG}`], { okCodes: [0, 128] });
  const config = readHookConfig(read.code === 0 ? read.stdout.toString('utf8') : null);
  if (config.invalid !== undefined) throw new Error('invalid security hook configuration');
  const hooks = config.hooks.filter((hook) => hook.alias === SECURITY_ALIAS).map((hook) => hook.id);
  return {
    configured: hooks.length > 0,
    async check(files) {
      if (hooks.length === 0) return [];
      const dir = await mkdtemp(join(tmpdir(), 'capture-security-'));
      try {
        const scratch = new Git(dir);
        await scratch.run(['init', '--quiet']);
        const entries = (await listTree(git, tracked)).filter((entry) => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode));
        const blobs = await readBlobs(git, entries.map((entry) => entry.oid));
        for (const entry of entries) {
          checkRepoPath(entry.path);
          await mkdir(dirname(join(dir, entry.path)), { recursive: true });
          await writeFile(join(dir, entry.path), blobs.get(entry.oid)!, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
        }
        for (const [path, content] of files) {
          checkRepoPath(path);
          // Configuration and executable support files always come from the tracked branch.
          if (path === PRE_COMMIT_CONFIG || path.startsWith('.git/')) return [{ hook: SECURITY_ALIAS, line: 1 }];
          await mkdir(dirname(join(dir, path)), { recursive: true });
          await writeFile(join(dir, path), content);
        }
        // Hooks that inspect the index see the candidate too. This repository
        // has no remote and is deleted in finally, including all its objects.
        await scratch.run(['add', '--all']);
        const findings: SecurityFinding[] = [];
        for (const stage of ['pre-commit', 'pre-push']) {
          const result = await runHooks(dir, ['run', SECURITY_ALIAS, '--hook-stage', stage, '--files', ...files.keys()]);
          if (result.code !== 0) {
            const failed = hooks.filter((id) => result.output.includes(`- hook id: ${id}\n`));
            const lines = [...result.output.matchAll(/(?:\bline\s+|:)(\d+)(?::|\b)/g)].map((match) => Number(match[1])).filter((line) => Number.isSafeInteger(line) && line > 0);
            for (const hook of failed.length > 0 ? failed : [SECURITY_ALIAS]) findings.push({ hook, line: lines[0] ?? 1 });
          }
        }
        // A security hook that rewrites content is still a rejection. Capture only what Linear returned.
        for (const [path, content] of files) {
          const after = await readFile(join(dir, path)).catch(() => null);
          if (after === null || !after.equals(Buffer.from(content))) findings.push({ hook: SECURITY_ALIAS, line: 1 });
        }
        return findings;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

// Hook output is untrusted: retain only configured hook ids and line numbers.
// Candidates stay in a disposable repository with no remote until accepted.
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
  close?(): Promise<void>;
}

/** Neither errors nor returned findings contain raw hook output. */
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

/** Uses the tracked branch's configuration and support files, never a Linear-supplied config. */
export async function securityGate(git: Git, tracked: Oid): Promise<SecurityGate> {
  const read = await git.run(['cat-file', 'blob', `${tracked}:${PRE_COMMIT_CONFIG}`], { okCodes: [0, 128] });
  const config = readHookConfig(read.code === 0 ? read.stdout.toString('utf8') : null);
  if (config.invalid !== undefined) throw new Error('invalid security hook configuration');
  const hooks = config.hooks.filter((hook) => hook.alias === SECURITY_ALIAS).map((hook) => hook.id);
  let dir: string | undefined;
  let scratch: Git;
  let baseline: string;
  const close = async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  };
  return {
    configured: hooks.length > 0,
    close,
    async check(files) {
      if (hooks.length === 0) return [];
      try {
        if (dir === undefined) {
          dir = await mkdtemp(join(tmpdir(), 'capture-security-'));
          scratch = new Git(dir);
          await scratch.run(['init', '--quiet']);
          const entries = (await listTree(git, tracked)).filter((entry) => entry.type === 'blob' && ['100644', '100755'].includes(entry.mode));
          // Read supporting files in bounded batches; large repositories are not held in memory.
          for (let at = 0; at < entries.length; at += 32) {
            const batch = entries.slice(at, at + 32);
            const blobs = await readBlobs(git, batch.map((entry) => entry.oid));
            for (const entry of batch) {
              checkRepoPath(entry.path);
              await mkdir(dirname(join(dir, entry.path)), { recursive: true });
              await writeFile(join(dir, entry.path), blobs.get(entry.oid)!, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
            }
          }
          await scratch.run(['add', '--all']);
          baseline = await scratch.text(['write-tree']);
        }
        // Restore only our disposable repository, including hook changes from the previous document.
        await scratch.run(['read-tree', '--reset', '-u', baseline]);
        await scratch.run(['clean', '-fdx', '--quiet']);
        for (const [path, content] of files) {
          checkRepoPath(path);
          if (path === PRE_COMMIT_CONFIG) return [{ hook: SECURITY_ALIAS, line: 1 }];
          await mkdir(dirname(join(dir, path)), { recursive: true });
          await writeFile(join(dir, path), content);
        }
        // Index-inspecting hooks see the candidate too. This repository has no remote.
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
        // Capture only Linear's text. A security hook that rewrites it is a rejection.
        for (const [path, content] of files) {
          const after = await readFile(join(dir, path)).catch(() => null);
          if (after === null || !after.equals(Buffer.from(content))) findings.push({ hook: SECURITY_ALIAS, line: 1 });
        }
        return findings;
      } catch {
        // Spawn, filesystem and configuration failures must fail closed without exposing content.
        return [{ hook: SECURITY_ALIAS, line: 1 }];
      }
    },
  };
}

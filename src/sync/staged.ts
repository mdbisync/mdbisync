// The security hooks in a step of their own. A sync job runs in three steps:
//
// 1. `stage`: the action, with the Linear token and the App token, reads
//    Linear's changes and writes each set of files the hooks must see to a
//    folder in the runner's temporary directory, with Linear's answers to
//    its reads. It writes nothing to git or Linear.
// 2. The hooks step: a plain step that holds only the keys the deployer
//    gives to hooks runs the repository's security hooks on every staged
//    set and writes their findings (hook id and line, never the matched
//    text) beside them.
// 3. `apply`: the action runs the operation again. Its capture takes the
//    stage step's answers instead of reading Linear again, so it sees what
//    the hooks saw and a run reads Linear once (`src/linear/reads.ts`); the
//    rest of the run, the checks before a write included, reads Linear
//    itself. It answers each set from the findings, by the content hash of
//    every file in it. A set without an answer (step 2 did not run, or the
//    tracked branch moved) is not pushed; the next run checks it.
//
// The folder holds document content on the runner's disk only; it is never
// uploaded, and the apply step removes it when its operation ends.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Git, type Oid, checkRepoPath } from '../state/index.ts';
import { SECURITY_ALIAS } from '../setup/hooks.ts';
import { type SecurityFinding, type SecurityGate, securityGate, securityHookIds } from './security.ts';

export const SECURITY_STEPS = ['stage', 'apply'] as const;
export type SecurityStep = (typeof SECURITY_STEPS)[number];

/** The staging folder's name under the runner's temporary directory. */
export const STAGE_FOLDER = 'mdbisync-candidates';
const MANIFEST = 'manifest.json';
const ANSWERS = 'answers.json';
const READS = 'linear-reads.json';
const VERSION = 1;

interface Manifest {
  version: number;
  /** The tracked commit whose configuration and support files the hooks use. */
  tracked: Oid;
  sets: Array<{ key: string; files: Array<{ path: string; sha256: string }> }>;
}

interface Answers {
  version: number;
  tracked: Oid;
  answers: Record<string, SecurityFinding[]>;
}

/** The staging folder: `RUNNER_TEMP` on a runner, the system's temporary directory elsewhere. */
export function stageFolder(env: NodeJS.ProcessEnv = process.env): string {
  const base = env['RUNNER_TEMP'];
  if (base === undefined || base === '') throw new Error('RUNNER_TEMP is not set; the staged security steps run in a GitHub Actions job');
  return join(base, STAGE_FOLDER);
}

/** Where the stage step keeps Linear's answers to its reads for the apply step. */
export const readsFile = (folder: string) => join(folder, READS);

const sha256 = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');

/** One answer per set of files: the paths and the hashes of their bytes. */
export function candidateKey(files: ReadonlyMap<string, Buffer | string>): string {
  const pairs = [...files].map(([path, content]) => [path, sha256(content)]).sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0));
  return sha256(JSON.stringify(pairs));
}

export interface StagingGate extends SecurityGate {
  /** Writes the manifest; the sets recorded so far are what the hooks step checks. */
  finish(): Promise<number>;
}

/**
 * Step 1: records every set the operation asks about and answers it as if it
 * passed, so the operation goes on to stage the rest. Nothing it stages is
 * written anywhere but the folder.
 */
export async function stagingGate(git: Git, tracked: Oid, folder: string): Promise<StagingGate> {
  const configured = (await securityHookIds(git, tracked)).length > 0;
  await rm(folder, { recursive: true, force: true });
  await mkdir(join(folder, 'files'), { recursive: true, mode: 0o700 });
  const sets = new Map<string, Manifest['sets'][number]>();
  return {
    configured,
    async check(files) {
      if (!configured) return [];
      const key = candidateKey(files);
      if (!sets.has(key)) {
        const entries: Manifest['sets'][number]['files'] = [];
        for (const [path, content] of files) {
          checkRepoPath(path);
          const hash = sha256(content);
          await writeFile(join(folder, 'files', hash), content, { mode: 0o600 });
          entries.push({ path, sha256: hash });
        }
        sets.set(key, { key, files: entries });
      }
      return [];
    },
    async finish() {
      const manifest: Manifest = { version: VERSION, tracked, sets: [...sets.values()] };
      await writeFile(join(folder, MANIFEST), JSON.stringify(manifest), { mode: 0o600 });
      return sets.size;
    },
  };
}

/** Step 1 when the operation has nothing for the hooks: an empty manifest. */
export async function stageNothing(folder: string, tracked: Oid | null): Promise<void> {
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(join(folder, MANIFEST), JSON.stringify({ version: VERSION, tracked: tracked ?? '', sets: [] } satisfies Manifest), { mode: 0o600 });
}

export interface StagedCheck {
  sets: number;
  /** Sets with at least one finding. */
  rejected: number;
  /** Sets whose staged bytes did not match their hash; they get no answer. */
  unanswered: number;
}

/**
 * Step 2: runs the tracked branch's security hooks on every staged set, with
 * `env` as the hooks' environment, and writes the findings beside them.
 */
export async function checkStaged(git: Git, folder: string, env: Record<string, string>): Promise<StagedCheck> {
  const manifest = JSON.parse(await readFile(join(folder, MANIFEST), 'utf8')) as Manifest;
  if (manifest.version !== VERSION) throw new Error('the staged candidates come from another version of the action');
  const result: StagedCheck = { sets: manifest.sets.length, rejected: 0, unanswered: 0 };
  const answers: Answers = { version: VERSION, tracked: manifest.tracked, answers: {} };
  if (manifest.sets.length > 0) {
    const gate = await securityGate(git, manifest.tracked, { env });
    try {
      for (const set of manifest.sets) {
        const files = new Map<string, Buffer>();
        for (const { path, sha256: hash } of set.files) {
          checkRepoPath(path);
          if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('the staged manifest names a file that is not a content hash');
          files.set(path, await readFile(join(folder, 'files', hash)));
        }
        if ([...files].some(([path, content]) => sha256(content) !== set.files.find((file) => file.path === path)?.sha256) || candidateKey(files) !== set.key) {
          result.unanswered += 1;
          continue;
        }
        const findings = (await gate.check(files)) ?? [{ hook: SECURITY_ALIAS, line: 1 }];
        if (findings.length > 0) result.rejected += 1;
        answers.answers[set.key] = findings;
      }
    } finally {
      await gate.close?.();
    }
  }
  await writeFile(join(folder, ANSWERS), JSON.stringify(answers), { mode: 0o600 });
  return result;
}

/**
 * Step 3: answers each set from the hooks step's findings. A set it has no
 * answer for gets null: the operation leaves it out of this run. Answers
 * from another tracked commit (the branch moved between the steps) count
 * as none.
 */
export async function answeringGate(git: Git, tracked: Oid, folder: string): Promise<SecurityGate> {
  const hooks = new Set(await securityHookIds(git, tracked));
  const configured = hooks.size > 0;
  let answers: Answers['answers'] = {};
  if (configured) {
    const text = await readFile(join(folder, ANSWERS), 'utf8').catch(() => null);
    const read = text === null ? null : (JSON.parse(text) as Answers);
    if (read !== null && read.version === VERSION && read.tracked === tracked) answers = read.answers;
  }
  return {
    configured,
    async check(files) {
      if (!configured) return [];
      const key = candidateKey(files);
      const found = Object.hasOwn(answers, key) ? answers[key] : undefined;
      if (!Array.isArray(found)) return null;
      // Only hook names the configuration gives reach Linear's comments.
      return found.map(({ hook, line }) => ({ hook: hooks.has(hook) ? hook : SECURITY_ALIAS, line: Number.isSafeInteger(line) && line > 0 ? line : 1 }));
    },
  };
}

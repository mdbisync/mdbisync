import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, it } from 'node:test';
import type { LinearDocument } from '../../../src/linear/index.ts';
import type { TestConfig } from './config.ts';
import { LinearWorld } from './linear-world.ts';
import { readOwnership } from './ownership.ts';
import { runGit, walkthrough, type WalkthroughOptions } from './walkthrough.ts';

const config: TestConfig = {
  sandboxUrl: 'https://github.com/example/sandbox', gitUrl: 'https://github.com/example/sandbox', owner: 'example', repo: 'sandbox',
  githubApp: { clientId: 'example-client', privateKey: 'unused' }, githubAppMissing: [], linearApps: [], editors: { 'editor-a': 'editor-key', 'editor-b': '' }, missing: [],
};
const RUN = 'abcdef';
const OTHER = '123456';

/** An in-memory test workspace behind the real LinearWorld: what the harness asks for, by operation name. */
class FakeLinear {
  teams = [{ id: 'team-eng', key: 'ENG', name: 'Engineering' }, { id: 'team-docs', key: 'DOCS', name: 'Docs' }];
  projects = new Map<string, { id: string; name: string; createdAt: string }>();
  documents = new Map<string, LinearDocument>();
  writes: string[] = [];
  stopped = undefined;

  project(id: string, name: string): void {
    this.projects.set(id, { id, name, createdAt: new Date().toISOString() });
  }

  document(id: string, fields: Partial<LinearDocument>): void {
    this.documents.set(id, { id, title: id, slugId: id, icon: null, color: null, content: 'Body\n', documentContentId: null, projectId: null, teamId: null,
      trashed: false, archivedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...fields });
  }

  async request(name: string, _kind: string, _query: string, variables: { input?: { id: string; name: string }; id?: string } = {}): Promise<unknown> {
    if (name === 'Teams') return { teams: { nodes: this.teams } };
    if (name === 'RunProjects') return { projects: { nodes: [...this.projects.values()], pageInfo: { hasNextPage: false, endCursor: null } } };
    if (name === 'CreateProject') {
      const { id, name: projectName } = variables.input!;
      this.writes.push(`create ${projectName}`);
      this.project(id, projectName);
      return { projectCreate: { success: true, project: this.projects.get(id) } };
    }
    if (name === 'DeleteProject') {
      const project = this.projects.get(variables.id!)!;
      this.writes.push(`delete ${project.name}`);
      // Linear archives a deleted project's documents.
      for (const document of this.documents.values()) if (document.projectId === project.id) document.archivedAt = new Date().toISOString();
      this.projects.delete(project.id);
      return { projectDelete: { success: true } };
    }
    throw new Error(`unexpected operation ${name}`);
  }

  async listDocuments(place: { teamId?: string }, options: { includeArchived?: boolean } = {}): Promise<LinearDocument[]> {
    return [...this.documents.values()].filter((document) => document.teamId === place.teamId
      && (options.includeArchived === true || (document.archivedAt === null && !document.trashed))).map((document) => ({ ...document }));
  }

  async getDocuments(ids: readonly string[]): Promise<LinearDocument[]> {
    return ids.flatMap((id) => (this.documents.has(id) ? [{ ...this.documents.get(id)! }] : []));
  }

  async updateDocument(id: string, patch: Partial<LinearDocument>): Promise<LinearDocument> {
    this.writes.push(`update ${id}`);
    Object.assign(this.documents.get(id)!, patch);
    return this.documents.get(id)!;
  }

  async restoreDocument(id: string): Promise<void> {
    this.writes.push(`restore ${id}`);
    this.documents.get(id)!.trashed = false;
  }

  async trashDocument(id: string): Promise<void> {
    this.writes.push(`trash ${id}`);
    this.documents.get(id)!.trashed = true;
  }
}

let stateDir: string;
let linear: FakeLinear;
let refs: string[];
let ids: Map<string, string>;
let pulls: Array<{ number: number; head: { ref: string } }>;
let runs: Array<{ id: number; head_branch: string; status: string }>;
let deleted: string[][];
let shared: string[] | Error;
let output: string[];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'walkthrough-linear-'));
  linear = new FakeLinear();
  refs = [`refs/heads/t/${RUN}/main`, `refs/heads/t/${RUN}/sync`, `refs/mdbisync-t/${RUN}/ids`];
  ids = new Map();
  pulls = [{ number: 5, head: { ref: `t/${RUN}/sync` } }];
  runs = [{ id: 1, head_branch: `t/${RUN}/main`, status: 'completed' }];
  deleted = [];
  shared = [];
  output = [];
});
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); });

function options(): WalkthroughOptions {
  const git = {
    refs: async (runId: string) => refs.filter((ref) => ref.includes(`/${runId}/`)),
    deleteRefs: async (_runId: string, list: readonly string[]) => { deleted.push([...list]); refs = refs.filter((ref) => !list.includes(ref)); },
    ids: async () => ids,
    sharedRuns: async () => { if (shared instanceof Error) throw shared; return shared; },
  };
  const rest = {
    workflowRuns: async (branch: string) => runs.filter((run) => run.head_branch === branch),
    pullRequests: async (prefix: string) => pulls.filter((pr) => pr.head.ref.startsWith(prefix)),
    closeOpenPullRequests: async (prefix: string) => {
      const closed = pulls.filter((pr) => pr.head.ref.startsWith(prefix)).map((pr) => pr.number);
      pulls = pulls.filter((pr) => !pr.head.ref.startsWith(prefix));
      return closed;
    },
  };
  return {
    config, stateDir, now: () => new Date('2026-11-12T10:00:00Z'),
    linear: () => new LinearWorld(linear as never),
    connect: async () => ({ rest: rest as never, git, push: async () => {}, safe: (text: string) => text.replaceAll('editor-key', '[redacted]') }),
    write: (text: string) => { output.push(text); },
  };
}

const call = (...args: string[]) => walkthrough([...args, '--run', RUN], options());

it('refuses Linear options outside their commands before reading anything', async () => {
  let touched = false;
  const guarded = { ...options(), linear: () => { touched = true; throw new Error('unexpected'); }, connect: async () => { touched = true; throw new Error('unexpected'); } };
  for (const args of [
    ['list', '--team', 'ENG'], ['cleanup', '--path', 'docs/a.md'], ['trash', '--team', 'eng'], ['trash', '--team', 'ENG', '--team', 'ENG'],
    ['project'], ['project', '--team', 'ENG', '--team', 'DOCS'], ['trash'], ['linear-edit'], ['linear-read', '--path', 'docs/a.md', '--text', 'x'],
    ['linear-edit', '--path', 'docs/a.md', '--text', 'one\ntwo'], ['linear-edit', '--path', 'docs/a.md', '--text', 'x'.repeat(201)],
    ['cleanup', '--ref', `t/${RUN}/main`], ['project', '--team', 'ENG', '--dir', '.'],
  ]) await assert.rejects(walkthrough([...args, '--run', RUN], guarded), Error, args.join(' '));
  await assert.rejects(walkthrough(['project', '--team', 'ENG', '--run', 'ABCDEF'], guarded));
  assert.equal(touched, false);
});

it('creates the run project once, records it, and refuses an unknown team', async () => {
  assert.equal(await call('project', '--team', 'ENG'), 0);
  assert.deepEqual(linear.writes, [`create Field notes ${RUN}`]);
  assert.match(output.join(''), /linear-project: Field notes abcdef/);
  assert.equal(await call('project', '--team', 'ENG'), 0);
  assert.deepEqual(linear.writes, [`create Field notes ${RUN}`]);
  const owned = readOwnership(stateDir, RUN)!;
  assert.deepEqual([...owned.projects.values()], [`Field notes ${RUN}`]);
  assert.deepEqual([...owned.teamIds], ['team-eng']);
  await assert.rejects(call('project', '--team', 'OPS'), /no team with key OPS/);
  // An existing project's team is not known, so another team is not recorded as the run's zone.
  await call('project', '--team', 'DOCS');
  assert.deepEqual([...readOwnership(stateDir, RUN)!.teamIds], ['team-eng']);
});

it('reads zone trash counts and keeps the first reading as the baseline', async () => {
  linear.document('trashed-1', { teamId: 'team-eng', trashed: true });
  linear.document('in-project', { teamId: 'team-eng', projectId: 'p', trashed: true });
  assert.equal(await call('trash', '--team', 'ENG', '--team', 'DOCS'), 0);
  assert.deepEqual(JSON.parse(output.pop()!), { trash: { ENG: 1, DOCS: 0 }, baseline: { ENG: 1, DOCS: 0 } });
  linear.document('trashed-2', { teamId: 'team-docs', trashed: true });
  await call('trash', '--team', 'DOCS');
  assert.deepEqual(JSON.parse(output.pop()!), { trash: { DOCS: 1 }, baseline: { ENG: 1, DOCS: 0 } });
  assert.deepEqual(linear.writes, []);
});

it('edits and reads only a synced document of the run', async () => {
  linear.project('p-run', `Field notes ${RUN}`);
  linear.project('p-other', `Field notes ${OTHER}`);
  linear.document('doc-run', { projectId: 'p-run', teamId: 'team-eng', content: 'First line\n' });
  linear.document('doc-other', { projectId: 'p-other', teamId: 'team-eng' });
  linear.document('doc-zone', { teamId: 'team-eng', title: `${OTHER}/notes` });
  linear.document('doc-key', { projectId: 'p-run', teamId: 'team-eng', content: 'editor-key\n' });
  ids = new Map([['docs/a.md', 'doc-run'], ['docs/b.md', 'doc-other'], ['docs/c.md', 'doc-zone'], ['docs/d.md', 'doc-key']]);
  assert.equal(await call('linear-edit', '--path', 'docs/a.md'), 0);
  assert.equal(linear.documents.get('doc-run')!.content, 'First line\n\nChecked again on 2026-11-12.\n');
  assert.equal(await call('linear-edit', '--path', 'docs/a.md', '--text', 'Agreed with the team.'), 0);
  assert.equal(await call('linear-read', '--path', 'docs/a.md'), 0);
  assert.equal(output.at(-1), 'First line\n\nChecked again on 2026-11-12.\n\nAgreed with the team.\n\n');
  await call('linear-read', '--path', 'docs/d.md');
  assert.ok(!output.at(-1)!.includes('editor-key'));
  const writes = linear.writes.length;
  await assert.rejects(call('linear-edit', '--path', 'docs/b.md'), /not the selected run's/);
  await assert.rejects(call('linear-edit', '--path', 'docs/c.md'), /not titled for the selected run/);
  await assert.rejects(call('linear-edit', '--path', 'docs/missing.md'), /no document for --path/);
  assert.equal(linear.writes.length, writes);
});

it('cleans up the run right away: archives, closes, deletes, and reports trash counts', async () => {
  await call('project', '--team', 'ENG');
  await call('trash', '--team', 'ENG', '--team', 'DOCS');
  const project = [...linear.projects.values()][0]!;
  linear.project('p-other', `Field notes ${OTHER}`);
  linear.document('doc-run', { projectId: project.id, teamId: 'team-eng' });
  linear.document('doc-trashed', { projectId: project.id, teamId: 'team-eng', trashed: true });
  linear.document('doc-zone', { teamId: 'team-docs', title: `${RUN}/notes` });
  // Trashed by the engine and no longer in the ids state ref: still archived, never left in the trash.
  linear.document('doc-zone-trashed', { teamId: 'team-docs', title: `${RUN}/old`, trashed: true });
  linear.document('doc-other', { projectId: 'p-other', teamId: 'team-eng' });
  ids = new Map([['docs/a.md', 'doc-run'], ['docs/b.md', 'doc-trashed']]);
  refs.push(`refs/heads/t/${OTHER}/main`);
  pulls.push({ number: 6, head: { ref: `t/${OTHER}/sync` } });
  output.length = 0;
  assert.equal(await call('cleanup', '--team', 'DOCS'), 0);
  const report = JSON.parse(output.join(''));
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.closedPullRequests, [5]);
  assert.deepEqual(report.removedRefs.sort(), [`refs/heads/t/${RUN}/main`, `refs/heads/t/${RUN}/sync`, `refs/mdbisync-t/${RUN}/ids`]);
  assert.deepEqual(report.trash, { DOCS: { baseline: 0, before: 1, after: 0 }, ENG: { baseline: 0, before: 0, after: 0 } });
  for (const id of ['doc-run', 'doc-trashed', 'doc-zone', 'doc-zone-trashed']) {
    const document = linear.documents.get(id)!;
    assert.ok(document.archivedAt !== null && !document.trashed, id);
  }
  // Nothing of the other run is touched, and nothing is trashed.
  assert.ok(linear.projects.has('p-other'));
  assert.equal(linear.documents.get('doc-other')!.archivedAt, null);
  assert.deepEqual(refs, [`refs/heads/t/${OTHER}/main`]);
  assert.deepEqual(pulls.map((pr) => pr.number), [6]);
  assert.ok(!linear.writes.some((write) => write.startsWith('trash')));
  assert.equal(readOwnership(stateDir, RUN), null);
  assert.equal(existsSync(join(stateDir, 'walkthrough', `${RUN}-trash.json`)), false);
});

it('refuses cleanup while a run is in progress or when the ids name a document outside the run, changing nothing', async () => {
  linear.project('p-run', `Field notes ${RUN}`);
  linear.project('p-other', `Field notes ${OTHER}`);
  linear.document('doc-other', { projectId: 'p-other', teamId: 'team-eng' });
  for (const branch of ['sync', 'schedule', 'suspended']) {
    runs.push({ id: 2, head_branch: `t/${RUN}/${branch}`, status: 'in_progress' });
    await assert.rejects(call('cleanup', '--team', 'ENG'), /runs 2 of the run are not completed/);
    runs.pop();
  }
  // A scenario run on another host, seen only in the shared state; an unreadable state also stops cleanup.
  shared = [RUN];
  await assert.rejects(call('cleanup', '--team', 'ENG'), /shared reservation/);
  shared = new Error('control ref unreadable');
  await assert.rejects(call('cleanup', '--team', 'ENG'));
  shared = [OTHER];
  await assert.rejects(call('cleanup'), /needs --team/);
  ids = new Map([['docs/a.md', 'doc-other']]);
  await assert.rejects(call('cleanup', '--team', 'ENG'), /outside the run's projects/);
  linear.document('doc-zone-other', { teamId: 'team-eng', title: `${OTHER}/notes` });
  ids = new Map([['docs/a.md', 'doc-zone-other']]);
  await assert.rejects(call('cleanup', '--team', 'ENG'), /outside the run's projects/);
  // The refusal leaves no record behind that would block a later cleanup.
  assert.equal(readOwnership(stateDir, RUN), null);
  assert.deepEqual(linear.writes, []);
  assert.deepEqual(deleted, []);
  assert.equal(pulls.length, 1);
});

it('retries a cleanup whose project an earlier attempt already deleted', async () => {
  await call('project', '--team', 'ENG');
  const project = [...linear.projects.values()][0]!;
  linear.document('doc-trashed', { projectId: project.id, teamId: 'team-eng', trashed: true });
  ids = new Map([['docs/a.md', 'doc-trashed']]);
  // The earlier attempt deleted the project but stopped before its refs.
  linear.projects.delete(project.id);
  output.length = 0;
  assert.equal(await call('cleanup', '--team', 'ENG'), 0);
  assert.deepEqual(JSON.parse(output.join('')).problems, []);
  assert.deepEqual(refs, []);
});

it('reads, fetches and deletes only the selected run\'s refs in a real repository', async () => {
  const root = mkdtempSync(join(tmpdir(), 'walkthrough-refs-'));
  try {
    const remote = join(root, 'remote.git'); const work = join(root, 'work');
    const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString();
    execFileSync('git', ['init', '--quiet', '--bare', remote]);
    execFileSync('git', ['init', '--quiet', work]);
    writeFileSync(join(work, 'ids.json'), JSON.stringify({ 'docs/a.md': { id: 'doc-1' } }));
    git(work, 'add', 'ids.json');
    git(work, '-c', 'user.name=Test Editor', '-c', 'user.email=editor@example.com', 'commit', '--quiet', '-m', 'State');
    git(work, 'push', '--quiet', remote, `HEAD:refs/heads/t/${RUN}/main`, `HEAD:refs/mdbisync-t/${RUN}/ids`, `HEAD:refs/heads/t/${OTHER}/main`, 'HEAD:refs/heads/main', `HEAD:refs/heads/t/${RUN}/other`);
    const runRefs = runGit(remote, {});
    assert.deepEqual((await runRefs.refs(RUN)).sort(), [`refs/heads/t/${RUN}/main`, `refs/mdbisync-t/${RUN}/ids`]);
    assert.deepEqual([...(await runRefs.ids(RUN))], [['docs/a.md', 'doc-1']]);
    assert.deepEqual([...(await runRefs.ids(OTHER))], []);
    assert.deepEqual(await runRefs.sharedRuns(), []);
    await assert.rejects(runRefs.deleteRefs(RUN, [`refs/heads/t/${OTHER}/main`]), /not the selected run's/);
    await assert.rejects(runRefs.deleteRefs(RUN, ['refs/heads/main']), /not the selected run's/);
    await runRefs.deleteRefs(RUN, await runRefs.refs(RUN));
    assert.deepEqual(git(remote, 'for-each-ref', '--format=%(refname)').trim().split('\n').sort(), ['refs/heads/main', `refs/heads/t/${OTHER}/main`, `refs/heads/t/${RUN}/other`]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

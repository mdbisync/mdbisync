// A run's ownership record and the recovery of a failed cleanup from it,
// against a fake Linear served over HTTP: the engine's writes go through the
// fault proxy and the harness's through its own clients, as in a live run.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { LinearClient } from '../../../src/linear/index.ts';
import { startFaultProxy } from './fault-proxy.ts';
import { LinearWorld, editorClient } from './linear-world.ts';
import { registerRun } from './locks.ts';
import { OwnershipLedger, readOwnership } from './ownership.ts';
import { sweep, type SweepTargets } from './sweeper.ts';

const roots: string[] = [];
const servers: FakeLinear[] = [];
after(async () => {
  roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
  await Promise.all(servers.map((server) => server.close()));
});

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'ownership-'));
  roots.push(root);
  return root;
}

/** Registers a run of this host whose process is gone, as a killed or finished run with a failed cleanup leaves it. */
function deadRun(dir: string, runId: string): void {
  registerRun(dir, runId);
  writeFileSync(join(dir, 'runs', `${runId}.json`), JSON.stringify({ pid: 2 ** 22 + 4321, host: hostname(), runId, since: '', heartbeatAt: new Date().toISOString() }));
}

interface FakeDocument {
  id: string;
  title: string;
  content: string;
  projectId: string | null;
  teamId: string | null;
  trashed: boolean;
  archivedAt: string | null;
}

interface FakeProject {
  id: string;
  name: string;
  teamIds: string[];
  deleted: boolean;
}

/**
 * The part of Linear's GraphQL API the harness and the engine's creates use.
 * Deleting a project archives its documents, as Linear does. Faults: a create
 * answered 503 before or after it was applied, the next N requests of an
 * operation answered 503, and deleted projects still listed (a stale read).
 */
class FakeLinear {
  documents = new Map<string, FakeDocument>();
  projects = new Map<string, FakeProject>();
  mutations: Array<{ operation: string; variables: Record<string, unknown> }> = [];
  /** Creates of these titles are applied and then answered 503. */
  appliedThen503 = new Set<string>();
  /** Creates of these titles are answered 503 and not applied. */
  refused503 = new Set<string>();
  failNext = new Map<string, number>();
  errorCodes = new Map<string, string>();
  afterDeleteFailures = new Map<string, number>();
  /** Creates of projects with these names are applied and then answered 503. */
  projectAppliedThen503 = new Set<string>();
  staleListed = new Set<string>();
  server: Server;
  url = '';

  constructor() {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { operationName: string; query: string; variables: Record<string, unknown> };
        const { status, answer } = this.answer(body.operationName, body.query, body.variables);
        response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
      });
    });
  }

  async start(): Promise<this> {
    servers.push(this);
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  close(): Promise<void> {
    if (!this.server.listening) return Promise.resolve();
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  raw(document: FakeDocument) {
    return {
      id: document.id, title: document.title, slugId: document.id.slice(0, 8), icon: null, color: null, content: document.content,
      trashed: document.trashed ? true : null, archivedAt: document.archivedAt, createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z',
      documentContentId: null, project: document.projectId === null ? null : { id: document.projectId }, team: document.teamId === null ? null : { id: document.teamId },
    };
  }

  unavailable() {
    return { status: 503, answer: { errors: [{ message: 'Service Unavailable', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] } };
  }

  answer(operation: string, query: string, variables: Record<string, unknown>): { status: number; answer: unknown } {
    if (query.trimStart().startsWith('mutation')) this.mutations.push({ operation, variables });
    const failures = this.failNext.get(operation) ?? 0;
    if (failures > 0) {
      this.failNext.set(operation, failures - 1);
      const code = this.errorCodes.get(operation);
      if (code !== undefined) return { status: 200, answer: { errors: [{ message: 'Internal server error', extensions: { code } }] } };
      return this.unavailable();
    }
    const input = (variables.input ?? {}) as Record<string, unknown>;
    switch (operation) {
      case 'CreateDocument': {
        const title = String(input.title);
        if (this.refused503.has(title)) return this.unavailable();
        const document: FakeDocument = {
          id: typeof input.id === 'string' ? input.id : randomUUID(), title, content: String(input.content ?? ''),
          projectId: (input.projectId as string | undefined) ?? null, teamId: (input.teamId as string | undefined) ?? null, trashed: false, archivedAt: null,
        };
        this.documents.set(document.id, document);
        if (this.appliedThen503.has(title)) return this.unavailable();
        return { status: 200, answer: { data: { documentCreate: { success: true, document: this.raw(document) } } } };
      }
      case 'CreateProject': {
        const project: FakeProject = { id: typeof input.id === 'string' ? input.id : randomUUID(), name: String(input.name), teamIds: input.teamIds as string[], deleted: false };
        this.projects.set(project.id, project);
        if (this.projectAppliedThen503.delete(project.name)) return this.unavailable();
        return { status: 200, answer: { data: { projectCreate: { success: true, project: { id: project.id, name: project.name, createdAt: new Date().toISOString() } } } } };
      }
      case 'DeleteProject': {
        const project = this.projects.get(String(variables.id));
        if (project === undefined || project.deleted) return { status: 200, answer: { data: null, errors: [{ message: 'Entity not found: Project' }] } };
        project.deleted = true;
        for (const [operation, count] of this.afterDeleteFailures) this.failNext.set(operation, count);
        this.afterDeleteFailures.clear();
        for (const document of this.documents.values()) if (document.projectId === project.id && document.archivedAt === null) document.archivedAt = new Date().toISOString();
        return { status: 200, answer: { data: { projectDelete: { success: true } } } };
      }
      case 'RunProjects': {
        const nodes = [...this.projects.values()].filter((project) => !project.deleted || this.staleListed.has(project.id)).map((project) => ({ id: project.id, name: project.name, createdAt: new Date().toISOString() }));
        return { status: 200, answer: { data: { projects: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } };
      }
      case 'GetDocuments': {
        const ids = new Set(variables.ids as string[]);
        return { status: 200, answer: { data: { documents: { nodes: [...this.documents.values()].filter((document) => ids.has(document.id)).map((document) => this.raw(document)) } } } };
      }
      case 'ListDocuments': {
        // A team's zone, as the sweeper reads it for leftovers by title.
        const teamId = (variables.filter as { team?: { id?: { eq?: string } } } | undefined)?.team?.id?.eq;
        const nodes = [...this.documents.values()]
          .filter((document) => document.teamId === teamId && document.projectId === null && (variables.includeArchived === true || document.archivedAt === null))
          .map((document) => this.raw(document));
        return { status: 200, answer: { data: { documents: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } };
      }
      case 'RestoreDocument': {
        const document = this.documents.get(String(variables.id));
        if (document === undefined) return { status: 200, answer: { data: null, errors: [{ message: 'Entity not found: Document' }] } };
        document.trashed = false;
        document.archivedAt = null;
        return { status: 200, answer: { data: { documentUnarchive: { success: true } } } };
      }
      case 'UpdateDocument': {
        const document = this.documents.get(String(variables.id));
        if (document === undefined) return { status: 200, answer: { data: null, errors: [{ message: 'Entity not found: Document' }] } };
        if (typeof input.projectId === 'string') {
          document.projectId = input.projectId;
          document.teamId = null;
        }
        return { status: 200, answer: { data: { documentUpdate: { success: true, document: this.raw(document) } } } };
      }
      default:
        return { status: 400, answer: { errors: [{ message: `the fake does not serve ${operation}` }] } };
    }
  }

  /** Mutations that named one of these ids. */
  touched(ids: readonly string[]): string[] {
    return this.mutations.filter((mutation) => ids.some((id) => JSON.stringify(mutation.variables).includes(id))).map((mutation) => mutation.operation);
  }
}

function targets(linear: FakeLinear): SweepTargets {
  return {
    sandbox: { runRefs: async () => [], deleteRunRefs: async () => {}, commitTime: async () => null } as never,
    rest: { pullRequests: async () => [], closePullRequest: async () => {} } as never,
    world: new LinearWorld(editorClient('key', linear.url)),
    teamIds: ['team-eng'],
  };
}

describe('ownership record', () => {
  it('recovers from a delete deadlock and transient archive-read errors without deleting again', async () => {
    const linear = await new FakeLinear().start();
    const dir = stateDir();
    const runId = 'abc123';
    const ledger = new OwnershipLedger(dir, runId);
    ledger.scope(['team-eng']);
    deadRun(dir, runId);
    const world = new LinearWorld(editorClient('key', linear.url, ledger));
    const project = await world.createProject('Field notes abc123', ['team-eng']);
    const document = await world.client.createDocument({ projectId: project.id }, { title: 'Plan', content: 'Next steps.' });
    linear.failNext.set('DeleteProject', 1);
    linear.errorCodes.set('DeleteProject', 'DEADLOCK_DETECTED');
    linear.errorCodes.set('GetDocuments', 'INTERNAL_SERVER_ERROR');
    linear.afterDeleteFailures.set('GetDocuments', 1);
    linear.afterDeleteFailures.set('RunProjects', 1);

    const report = await sweep(targets(linear), dir);
    assert.deepEqual(report.errors, []);
    assert.equal(report.recovered[0]?.verifiedArchived, 1);
    assert.deepEqual(report.recovered[0]?.problems, []);
    assert.equal(linear.documents.get(document.id)?.trashed, false);
    assert.ok(linear.documents.get(document.id)?.archivedAt);
    assert.equal(linear.mutations.filter((m) => m.operation === 'DeleteProject').length, 2);
    assert.equal(readOwnership(dir, runId), null);
    assert.equal(existsSync(join(dir, 'runs', `${runId}.json`)), false);
  });

  it('recovers a cleanup that failed half way from the record alone, and leaves everything else as it is', async () => {
    const linear = await new FakeLinear().start();
    const dir = stateDir();
    const runId = 'abc123';
    // Another run's team-zone README and project, in the same team: never touched.
    linear.documents.set('foreign-readme', { id: 'foreign-readme', title: 'README', content: 'Theirs.\n', projectId: null, teamId: 'team-eng', trashed: false, archivedAt: null });
    linear.projects.set('foreign-project', { id: 'foreign-project', name: 'Field notes 999999', teamIds: ['team-eng'], deleted: false });
    linear.documents.set('foreign-doc', { id: 'foreign-doc', title: 'plan', content: '', projectId: 'foreign-project', teamId: null, trashed: false, archivedAt: null });

    const ledger = new OwnershipLedger(dir, runId);
    ledger.scope(['team-eng']);
    deadRun(dir, runId);
    // The harness's own writes: a run project and a seeded document in it.
    const world = new LinearWorld(editorClient('key', linear.url, ledger));
    const project = await world.createProject('Field notes abc123', ['team-eng']);
    const seeded = await world.client.createDocument({ projectId: project.id }, { title: 'guides/start', content: 'Start.\n' });

    // The engine's writes, through the fault proxy: a team zone's README (no run prefix in its title), a prefixed
    // team-zone document, a project document, a create Linear applied but answered 503, and one it refused.
    const proxy = await startFaultProxy(linear.url, { observer: ledger });
    const engine = new LinearClient({ token: 'engine', baseUrl: proxy.url });
    const ids = { readme: randomUUID(), notes: randomUUID(), plan: randomUUID(), lost: randomUUID(), refused: randomUUID() };
    linear.appliedThen503.add('abc123/lost');
    linear.refused503.add('abc123/refused');
    await engine.createDocument({ teamId: 'team-eng' }, { id: ids.readme, title: 'README', content: 'Team notes.\n' });
    await engine.createDocument({ teamId: 'team-eng' }, { id: ids.notes, title: 'abc123/notes', content: 'Notes.\n' });
    await engine.createDocument({ projectId: project.id }, { id: ids.plan, title: 'plan', content: 'Plan.\n' });
    // The client reads the lost create back by its id and takes it as created; its answer was still a 503.
    assert.equal((await engine.createDocument({ teamId: 'team-eng' }, { id: ids.lost, title: 'abc123/lost', content: 'Lost.\n' })).id, ids.lost);
    await assert.rejects(engine.createDocument({ teamId: 'team-eng' }, { id: ids.refused, title: 'abc123/refused', content: 'Refused.\n' }));
    await proxy.close();

    // Everything is on record as it was created, a create whose answer never came included.
    const owned = readOwnership(dir, runId);
    assert.ok(owned !== null);
    assert.deepEqual([...owned.teamIds], ['team-eng']);
    assert.deepEqual([...owned.projects], [[project.id, 'Field notes abc123']]);
    assert.deepEqual(Object.fromEntries(owned.documents), {
      [seeded.id]: true, [ids.readme]: true, [ids.notes]: true, [ids.plan]: true, [ids.lost]: false, [ids.refused]: false,
    });

    // Cleanup fails half way: the project's deletion answers 503 and the team zone is never archived.
    linear.failNext.set('DeleteProject', 3);
    await assert.rejects(world.deleteProject(project, runId));
    assert.equal(linear.projects.get(project.id)?.deleted, false);

    const before = linear.mutations.length;
    const report = await sweep(targets(linear), dir);
    assert.deepEqual(report.errors, []);
    assert.equal(report.recovered.length, 1);
    const [recovery] = report.recovered;
    assert.deepEqual(recovery?.deletedProjects, ['Field notes abc123']);
    assert.equal(recovery?.archivedDocuments, 3);
    assert.equal(recovery?.verifiedArchived, 5);
    assert.deepEqual(recovery?.problems, []);

    // Every document the run created is archived and none is trashed; the refused create never existed.
    for (const id of [seeded.id, ids.readme, ids.notes, ids.plan, ids.lost]) {
      const document = linear.documents.get(id);
      assert.ok(document?.archivedAt !== null && document?.trashed === false, `document ${id} archived, not trashed`);
    }
    assert.equal(linear.documents.has(ids.refused), false);
    // No project of the run is left: neither its own nor the one that archived the team zone.
    assert.deepEqual([...linear.projects.values()].filter((p) => !p.deleted).map((p) => p.name), ['Field notes 999999']);
    // Nothing else was written to: the other run's README, project and document.
    assert.deepEqual(linear.touched(['foreign-readme', 'foreign-project', 'foreign-doc']), []);
    assert.equal(linear.documents.get('foreign-readme')?.archivedAt, null);
    assert.ok(linear.mutations.length > before);
    // Only after that proof are the registration and the record gone.
    assert.equal(existsSync(join(dir, 'runs', `${runId}.json`)), false);
    assert.equal(readOwnership(dir, runId), null);
  });

  it('refuses, changing nothing, when the record names a document outside the run\'s projects and team zones', async () => {
    const linear = await new FakeLinear().start();
    const dir = stateDir();
    const runId = 'def456';
    linear.documents.set('other-zone', { id: 'other-zone', title: 'README', content: '', projectId: null, teamId: 'team-ops', trashed: false, archivedAt: null });
    linear.documents.set('own', { id: 'own', title: 'def456/notes', content: '', projectId: null, teamId: 'team-eng', trashed: false, archivedAt: null });
    const ledger = new OwnershipLedger(dir, runId);
    ledger.scope(['team-eng']);
    ledger.record({ kind: 'document', id: 'own', confirmed: true });
    ledger.record({ kind: 'document', id: 'other-zone', confirmed: true });
    deadRun(dir, runId);

    const report = await sweep(targets(linear), dir);
    assert.match(report.errors.join('\n'), /refusing to recover run def456: document other-zone is in team team-ops, outside the run's team zones/);
    assert.deepEqual(linear.mutations, []);
    // The failure stays on record for a person to look at: registration and record are kept.
    assert.ok(existsSync(join(dir, 'runs', `${runId}.json`)));
    assert.ok(readOwnership(dir, runId) !== null);
  });

  it('refuses a recorded project that is not one of the run\'s', async () => {
    const linear = await new FakeLinear().start();
    const dir = stateDir();
    const runId = 'fed654';
    linear.projects.set('fixture', { id: 'fixture', name: 'Field notes 999999', teamIds: ['team-eng'], deleted: false });
    const ledger = new OwnershipLedger(dir, runId);
    ledger.record({ kind: 'project', id: 'fixture', name: 'Field notes 999999' });
    deadRun(dir, runId);
    const report = await sweep(targets(linear), dir);
    assert.match(report.errors.join('\n'), /project fixture \(Field notes 999999\) is not a project of the run/);
    assert.deepEqual(linear.mutations, []);
    assert.equal(linear.projects.get('fixture')?.deleted, false);
  });

  it('never deletes a project again when a stale read still lists it, and forgets the run once the read is current', async () => {
    const linear = await new FakeLinear().start();
    const dir = stateDir();
    const runId = 'aaa111';
    const ledger = new OwnershipLedger(dir, runId);
    ledger.scope(['team-eng']);
    deadRun(dir, runId);
    const world = new LinearWorld(editorClient('key', linear.url, ledger));
    const project = await world.createProject('Garden plans aaa111', ['team-eng']);
    await world.deleteProject(project, runId);
    linear.staleListed.add(project.id);

    const first = await sweep(targets(linear), dir);
    assert.match(first.errors.join('\n'), /project Garden plans aaa111 is still listed after Linear answered that it deleted it; not deleted again/);
    assert.equal(linear.mutations.filter((mutation) => mutation.operation === 'DeleteProject').length, 1);
    assert.ok(existsSync(join(dir, 'runs', `${runId}.json`)));

    linear.staleListed.clear();
    const second = await sweep(targets(linear), dir);
    assert.deepEqual(second.errors, []);
    assert.equal(linear.mutations.filter((mutation) => mutation.operation === 'DeleteProject').length, 1);
    assert.equal(existsSync(join(dir, 'runs', `${runId}.json`)), false);
  });

  it('archives the run\'s prefixed team-zone documents its record lacks (an engine that ran in Actions), and handles trashed and deleted ones', async () => {
    const linear = await new FakeLinear().start();
    const dir = stateDir();
    const runId = 'ddd555';
    const ledger = new OwnershipLedger(dir, runId);
    ledger.scope(['team-eng']);
    deadRun(dir, runId);
    const world = new LinearWorld(editorClient('key', linear.url, ledger));
    const kept = await world.createProject('Market study ddd555', ['team-eng']);
    const gone = await world.createProject('River survey ddd555', ['team-eng']);
    // A scenario trashed one document in each project, and deleted another for good.
    const trashedKept = await world.client.createDocument({ projectId: kept.id }, { id: randomUUID(), title: 'kept', content: '' });
    const trashedGone = await world.client.createDocument({ projectId: gone.id }, { id: randomUUID(), title: 'gone', content: '' });
    const deleted = await world.client.createDocument({ projectId: kept.id }, { id: randomUUID(), title: 'deleted', content: '' });
    for (const id of [trashedKept.id, trashedGone.id]) Object.assign(linear.documents.get(id) as FakeDocument, { trashed: true, archivedAt: new Date().toISOString() });
    linear.documents.delete(deleted.id);
    await world.deleteProject(gone, runId);
    // Written by an engine outside the proxy: not on record, but titled with the run's prefix.
    linear.documents.set('actions-doc', { id: 'actions-doc', title: 'ddd555/guides/start', content: '', projectId: null, teamId: 'team-eng', trashed: false, archivedAt: null });

    const report = await sweep(targets(linear), dir);
    assert.deepEqual(report.errors, []);
    const [recovery] = report.recovered;
    assert.equal(recovery?.archivedDocuments, 1);
    assert.equal(recovery?.gone, 1);
    assert.equal(recovery?.trashedInDeletedProjects, 1);
    assert.ok(linear.documents.get('actions-doc')?.archivedAt !== null);
    // Restored before its project went, so the deletion archived it.
    assert.deepEqual([linear.documents.get(trashedKept.id)?.trashed, linear.documents.get(trashedKept.id)?.archivedAt !== null], [false, true]);
    assert.equal(readOwnership(dir, runId), null);
  });

  it('reads a record whose last line was cut off when its writer died, and keeps what is written after it', () => {
    const dir = stateDir();
    const ledger = new OwnershipLedger(dir, 'bbb222');
    ledger.record({ kind: 'document', id: 'd1', confirmed: false });
    ledger.record({ kind: 'document', id: 'd1', confirmed: true });
    ledger.record({ kind: 'document', id: 'd2', confirmed: true });
    appendFileSync(join(dir, 'owned', 'bbb222.jsonl'), '{"kind":"document","id":"d3"');
    assert.deepEqual(Object.fromEntries(readOwnership(dir, 'bbb222')?.documents ?? []), { d1: true, d2: true });
    new OwnershipLedger(dir, 'bbb222').projectDeleted('p1');
    assert.deepEqual([...(readOwnership(dir, 'bbb222')?.deletedProjects ?? [])], ['p1']);
  });

  it('refuses a recorded project that was renamed, rather than taking it for gone', async () => {
    const linear = await new FakeLinear().start();
    const dir = stateDir();
    const runId = 'ccc444';
    const ledger = new OwnershipLedger(dir, runId);
    ledger.scope(['team-eng']);
    deadRun(dir, runId);
    const world = new LinearWorld(editorClient('key', linear.url, ledger));
    const project = await world.createProject('Harbor log ccc444', ['team-eng']);
    (linear.projects.get(project.id) as FakeProject).name = 'Quarterly budget';
    const report = await sweep(targets(linear), dir);
    assert.match(report.errors.join('\n'), /project [0-9a-f-]+ is named Quarterly budget, recorded as Harbor log ccc444/);
    assert.equal(linear.mutations.filter((mutation) => mutation.operation === 'DeleteProject').length, 0);
    assert.ok(readOwnership(dir, runId) !== null);
  });

  it('records the project that archives a team zone before creating it, so a lost answer leaves nothing stranded', async () => {
    const linear = await new FakeLinear().start();
    const dir = stateDir();
    const runId = 'ccc333';
    const ledger = new OwnershipLedger(dir, runId);
    ledger.scope(['team-eng']);
    deadRun(dir, runId);
    const proxy = await startFaultProxy(linear.url, { observer: ledger });
    const engine = new LinearClient({ token: 'engine', baseUrl: proxy.url });
    const readme = randomUUID();
    await engine.createDocument({ teamId: 'team-eng' }, { id: readme, title: 'README', content: 'Team notes.\n' });
    await proxy.close();

    // Recovery's archive project is created but its answer is a 503.
    linear.projectAppliedThen503.add('Spare shelf ccc333');
    const first = await sweep(targets(linear), dir);
    assert.notDeepEqual(first.errors, []);
    const helper = [...linear.projects.values()].find((project) => project.name === 'Spare shelf ccc333');
    assert.ok(helper !== undefined && !helper.deleted);
    assert.equal(readOwnership(dir, runId)?.projects.get(helper.id), 'Spare shelf ccc333');

    // The next sweep deletes it from the record and archives the README.
    const second = await sweep(targets(linear), dir);
    assert.deepEqual(second.errors, []);
    assert.equal(helper.deleted, true);
    assert.ok(linear.documents.get(readme)?.archivedAt !== null);
    assert.equal([...linear.projects.values()].filter((project) => !project.deleted).length, 0);
    assert.equal(readOwnership(dir, runId), null);
  });
});

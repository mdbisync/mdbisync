// What a run owns in Linear, written down the moment it is created: every
// document id, every project (id and name) and the team zones the run may
// write in. The record is a file per run in the harness's state folder, kept
// until the run is cleaned up, so a cleanup that fails half way (an HTTP 503)
// is finished later from this record alone: no title prefix to match, no
// creation time to guess, and nothing that is not in it is ever touched.
//
// Writes are seen where they leave the harness: the fault proxy in front of
// the engine, and the harness's own Linear clients. A create the engine sends
// with its own id is recorded before Linear sees it, so a create whose answer
// never came back (a network error) is still the run's. Only ids and project
// names are kept, never titles or content.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { LinearDocument } from '../../../src/linear/index.ts';
import { RUN_ID_PATTERN, runOfProject, runNames } from './isolation.ts';
import type { LinearWorld, Project } from './linear-world.ts';

export type OwnedEntry =
  /** Team zones (team ids) the run may create documents in. */
  | { kind: 'scope'; teamIds: string[] }
  | { kind: 'project'; id: string; name: string }
  /** Linear answered that it deleted the project: never deleted again, even when a stale read still lists it. */
  | { kind: 'project-deleted'; id: string }
  /** `confirmed` once Linear answered that it created the document; before that, only asked for. */
  | { kind: 'document'; id: string; confirmed: boolean };

/** Sees each GraphQL write as it leaves: the request before it is sent, and Linear's answer. */
export interface WriteObserver {
  before(requestBody: string): void;
  after(requestBody: string, answer: Uint8Array): void;
}

export interface Ownership {
  runId: string;
  teamIds: Set<string>;
  /** Project id → name. */
  projects: Map<string, string>;
  /** Projects Linear answered it deleted. */
  deletedProjects: Set<string>;
  /** Document id → whether Linear confirmed its creation. */
  documents: Map<string, boolean>;
}

function ownedDir(stateDir: string): string {
  return join(stateDir, 'owned');
}

function ledgerFile(stateDir: string, runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`run id must be six hex characters: ${runId}`);
  return join(ownedDir(stateDir), `${runId}.jsonl`);
}

function parse(text: string): { query?: unknown; variables?: { input?: { id?: unknown; name?: unknown } }; data?: Record<string, unknown> | null } | null {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' ? (value as ReturnType<typeof parse>) : null;
  } catch {
    return null;
  }
}

function payloadOf(data: Record<string, unknown> | null | undefined, field: string, inner: string): Record<string, unknown> | null {
  const payload = data?.[field];
  if (payload === null || typeof payload !== 'object' || (payload as { success?: unknown }).success === false) return null;
  const value = (payload as Record<string, unknown>)[inner];
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** The run's record, appended to as things are created; every entry is on disk before the call returns. */
export class OwnershipLedger implements WriteObserver {
  readonly runId: string;
  readonly stateDir: string;
  readonly #file: string;

  constructor(stateDir: string, runId: string) {
    this.runId = runId;
    this.stateDir = stateDir;
    this.#file = ledgerFile(stateDir, runId);
    mkdirSync(ownedDir(stateDir), { recursive: true });
  }

  record(entry: OwnedEntry): void {
    const fd = openSync(this.#file, 'a');
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  scope(teamIds: Iterable<string>): void {
    this.record({ kind: 'scope', teamIds: [...teamIds].sort() });
  }

  project(project: Pick<Project, 'id' | 'name'>): void {
    this.record({ kind: 'project', id: project.id, name: project.name });
  }

  projectDeleted(id: string): void {
    this.record({ kind: 'project-deleted', id });
  }

  /** A document or project create that carries its own id is the run's before Linear sees it. */
  before(requestBody: string): void {
    const request = parse(requestBody);
    if (typeof request?.query !== 'string' || !/^\s*mutation\b/.test(request.query)) return;
    const input = request.variables?.input;
    if (typeof input?.id !== 'string' || input.id === '') return;
    if (/\bdocumentCreate\s*\(/.test(request.query)) this.record({ kind: 'document', id: input.id, confirmed: false });
    else if (/\bprojectCreate\s*\(/.test(request.query) && typeof input.name === 'string') this.record({ kind: 'project', id: input.id, name: input.name });
  }

  /** Documents and projects Linear answered that it created, and projects it answered that it deleted. */
  after(requestBody: string, answer: Uint8Array): void {
    const data = parse(Buffer.from(answer).toString('utf8'))?.data;
    const deleted = data?.projectDelete;
    const deletedId = (parse(requestBody)?.variables as { id?: unknown } | undefined)?.id;
    if (deleted !== null && typeof deleted === 'object' && (deleted as { success?: unknown }).success === true && typeof deletedId === 'string') this.projectDeleted(deletedId);
    const document = payloadOf(data, 'documentCreate', 'document');
    if (typeof document?.id === 'string') this.record({ kind: 'document', id: document.id, confirmed: true });
    const project = payloadOf(data, 'projectCreate', 'project');
    if (typeof project?.id === 'string' && typeof project.name === 'string') this.record({ kind: 'project', id: project.id, name: project.name });
  }
}

/** A fetch that shows every request with a body, and its answer, to `observer`. */
export function observingFetch(base: typeof fetch, observer: WriteObserver | undefined): typeof fetch {
  if (observer === undefined) return base;
  return async (input, init) => {
    const body = typeof init?.body === 'string' ? init.body : undefined;
    if (body !== undefined) observer.before(body);
    const response = await base(input, init);
    if (body !== undefined) observer.after(body, new Uint8Array(await response.clone().arrayBuffer()));
    return response;
  };
}

/** The run's record, or null when it has none. A torn last line (the process died while writing) is skipped. */
export function readOwnership(stateDir: string, runId: string): Ownership | null {
  let text: string;
  try {
    text = readFileSync(ledgerFile(stateDir, runId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const owned: Ownership = { runId, teamIds: new Set(), projects: new Map(), deletedProjects: new Set(), documents: new Map() };
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let entry: OwnedEntry;
    try {
      entry = JSON.parse(line) as OwnedEntry;
    } catch {
      continue;
    }
    if (entry.kind === 'scope') entry.teamIds.forEach((id) => owned.teamIds.add(id));
    else if (entry.kind === 'project') owned.projects.set(entry.id, entry.name);
    else if (entry.kind === 'project-deleted') owned.deletedProjects.add(entry.id);
    else if (entry.kind === 'document') owned.documents.set(entry.id, entry.confirmed || owned.documents.get(entry.id) === true);
  }
  return owned;
}

export function forgetOwnership(stateDir: string, runId: string): void {
  rmSync(ledgerFile(stateDir, runId), { force: true });
}

/** Run ids that have a record. */
export function ownedRuns(stateDir: string): string[] {
  try {
    return readdirSync(ownedDir(stateDir)).flatMap((name) => {
      const runId = /^([0-9a-f]{6})\.jsonl$/.exec(name)?.[1];
      return runId === undefined ? [] : [runId];
    });
  } catch {
    return [];
  }
}

export class OwnershipRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnershipRefusal';
  }
}

export interface Recovery {
  runId: string;
  deletedProjects: string[];
  archivedDocuments: number;
  /** Documents already archived (not trashed) before recovery. */
  alreadyArchived: number;
  /** Created documents now archived and not trashed. */
  verifiedArchived: number;
  /** What recovery could not do or could not verify; the run is recovered only when this is empty. */
  problems: string[];
}

type Reader = Pick<LinearWorld, 'runProjects' | 'deleteProject' | 'archiveRunTeamDocuments'> & { client: Pick<LinearWorld['client'], 'getDocuments'> };

/**
 * Finishes a run's cleanup from its record alone, then checks the result.
 *
 * Before any change it reads every recorded document and project and refuses,
 * changing nothing, when one is not the run's: a project whose name is no
 * project of the run, or a live document outside the run's projects and team
 * zones. Then it deletes each recorded project that still exists, once, and
 * archives the recorded documents left live (or trashed) in a team zone
 * through a project of the run, which is recorded too. Last it reads again:
 * every created document must be archived and not trashed, and no project of
 * the run may be left. A project Linear once answered it deleted is never
 * deleted again: a stale read that still lists it is reported, not hidden.
 */
export async function recoverOwned(world: Reader, owned: Ownership, ledger: Pick<OwnershipLedger, 'project' | 'projectDeleted'>): Promise<Recovery> {
  const { runId } = owned;
  const recovery: Recovery = { runId, deletedProjects: [], archivedDocuments: 0, alreadyArchived: 0, verifiedArchived: 0, problems: [] };

  for (const [id, name] of owned.projects) {
    if (runOfProject(name) !== runId) throw new OwnershipRefusal(`refusing to recover run ${runId}: project ${id} (${name}) is not a project of the run`);
  }
  const ownedProjects = (projects: Awaited<ReturnType<Reader['runProjects']>>) => projects.filter((project) => owned.projects.has(project.id));
  const existing = ownedProjects(await world.runProjects());
  for (const project of existing) {
    if (project.name !== owned.projects.get(project.id)) throw new OwnershipRefusal(`refusing to recover run ${runId}: project ${project.id} is named ${project.name}, recorded as ${owned.projects.get(project.id)}`);
  }

  const ids = [...owned.documents.keys()];
  const before = await world.client.getDocuments(ids);
  const zone: LinearDocument[] = [];
  const foreign: string[] = [];
  for (const document of before) {
    if (!owned.documents.has(document.id)) continue;
    if (document.archivedAt !== null && !document.trashed) {
      recovery.alreadyArchived += 1;
    } else if (document.projectId !== null) {
      if (!owned.projects.has(document.projectId)) foreign.push(`document ${document.id} is in project ${document.projectId}, which is not the run's`);
    } else if (document.teamId !== null && owned.teamIds.has(document.teamId)) {
      zone.push(document);
    } else {
      foreign.push(`document ${document.id} is in team ${document.teamId ?? 'none'}, outside the run's team zones`);
    }
  }
  if (foreign.length > 0) throw new OwnershipRefusal(`refusing to recover run ${runId}: ${foreign.join('; ')}`);

  for (const project of existing) {
    if (owned.deletedProjects.has(project.id)) {
      recovery.problems.push(`project ${project.name} is still listed after Linear answered that it deleted it; not deleted again`);
      continue;
    }
    try {
      await world.deleteProject(project, runId);
      ledger.projectDeleted(project.id);
      recovery.deletedProjects.push(project.name);
    } catch (error) {
      recovery.problems.push(`project ${project.name}: ${(error as Error).message}`);
    }
  }
  if (zone.length > 0) {
    try {
      recovery.archivedDocuments = await world.archiveRunTeamDocuments(
        zone,
        runId,
        runNames(runId).helperProject('archive'),
        (document) => owned.documents.has(document.id),
        ledger,
      );
    } catch (error) {
      recovery.problems.push(`team-zone documents: ${(error as Error).message}`);
    }
  }

  // The proof: read everything again.
  const after = new Map((await world.client.getDocuments(ids)).map((document) => [document.id, document]));
  for (const [id, confirmed] of owned.documents) {
    const document = after.get(id);
    if (document === undefined) {
      // Only asked for and never created: nothing to clean up.
      if (confirmed) recovery.problems.push(`document ${id}: Linear no longer has it`);
    } else if (document.trashed) {
      recovery.problems.push(`document ${id} is trashed`);
    } else if (document.archivedAt === null) {
      recovery.problems.push(`document ${id} is not archived`);
    } else {
      recovery.verifiedArchived += 1;
    }
  }
  // The record is read again too: an archive project made just now is the run's.
  const left = (await world.runProjects()).filter((project) => project.runId === runId);
  for (const project of left) {
    recovery.problems.push(owned.projects.has(project.id) || project.name === runNames(runId).helperProject('archive')
      ? `project ${project.name} is still there`
      : `project ${project.name} (${project.id}) of the run is not in its record; left as it is`);
  }
  return recovery;
}

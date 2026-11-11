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

import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { LinearDocument } from '../../../src/linear/index.ts';
import { RUN_ID_PATTERN, runOfProject, runOfTeamTitle, runNames } from './isolation.ts';
import type { LinearWorld, Project } from './linear-world.ts';
import { retryCleanup } from './cleanup-retry.ts';
import { outputText, reportText } from '../../../src/run/output.ts';

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
    // Construct only the fields the journal understands; validate before opening it.
    const id = (value: unknown) => {
      const text = outputText(value, 256);
      if (text.trim() !== text || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('Invalid ownership id');
      return text;
    };
    let checked: OwnedEntry;
    switch (entry.kind) {
      case 'scope': checked = { kind: 'scope', teamIds: entry.teamIds.map(id) }; break;
      case 'project':
        if (typeof entry.name !== 'string' || entry.name.length > 4096) throw new Error('Invalid ownership name');
        checked = { kind: 'project', id: id(entry.id), name: entry.name };
        break;
      case 'project-deleted': checked = { kind: 'project-deleted', id: id(entry.id) }; break;
      case 'document':
        if (typeof entry.confirmed !== 'boolean') throw new Error('Invalid ownership confirmation');
        checked = { kind: 'document', id: id(entry.id), confirmed: entry.confirmed };
        break;
      default: throw new Error('Invalid ownership entry');
    }
    const flags = constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW;
    let fd: number;
    try {
      fd = openSync(this.#file, flags, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        fd = openSync(this.#file, flags | constants.O_CREAT | constants.O_EXCL, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // Another writer created the journal first. Open it without following a link.
        fd = openSync(this.#file, flags, 0o600);
      }
    }
    try {
      fchmodSync(fd, 0o600);
      // A writer that died mid-line left a torn tail: start on a new line, so this entry is not lost with it.
      const size = fstatSync(fd).size;
      const last = Buffer.alloc(1);
      const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
      writeSync(fd, reportText(`${torn ? '\n' : ''}${JSON.stringify(checked)}\n`));
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
    if (!isMutation(requestBody)) return;
    const request = parse(requestBody);
    if (typeof request?.query !== 'string') return;
    const input = request.variables?.input;
    if (typeof input?.id !== 'string' || input.id === '') return;
    if (/\bdocumentCreate\s*\(/.test(request.query)) this.record({ kind: 'document', id: input.id, confirmed: false });
    else if (/\bprojectCreate\s*\(/.test(request.query) && typeof input.name === 'string') this.record({ kind: 'project', id: input.id, name: input.name });
  }

  /** Documents and projects Linear answered that it created, and projects it answered that it deleted. */
  after(requestBody: string, answer: Uint8Array): void {
    if (!isMutation(requestBody)) return;
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

/** Whether a GraphQL request body is a mutation: only mutations create or delete anything, so reads are not parsed further. */
export function isMutation(requestBody: string): boolean {
  if (!requestBody.includes('mutation')) return false;
  const query = parse(requestBody)?.query;
  return typeof query === 'string' && /^\s*mutation\b/.test(query);
}

/**
 * Shows Linear's answer to a write to the observer. The write already happened, so a record that cannot be
 * written does not turn the answer into a failure: a create carries its own id and was recorded before it was
 * sent; what is lost is only the confirmation or a deletion's acknowledgement, which recovery reads back anyway.
 */
export function observeAnswer(observer: WriteObserver, requestBody: string, answer: Uint8Array): void {
  try {
    observer.after(requestBody, answer);
  } catch {
    // See above: nothing the write needs is lost.
  }
}

/** A fetch that shows every mutation it sends, and Linear's answer, to `observer`. */
export function observingFetch(base: typeof fetch, observer: WriteObserver | undefined): typeof fetch {
  if (observer === undefined) return base;
  return async (input, init) => {
    const body = typeof init?.body === 'string' && isMutation(init.body) ? init.body : undefined;
    if (body !== undefined) observer.before(body);
    const response = await base(input, init);
    if (body !== undefined) observeAnswer(observer, body, new Uint8Array(await response.clone().arrayBuffer()));
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

/** The documents the run's record holds, with whether Linear confirmed each create; empty when it has no record. */
export function ownedDocuments(ledger: Pick<OwnershipLedger, 'stateDir' | 'runId'>): Map<string, boolean> {
  return readOwnership(ledger.stateDir, ledger.runId)?.documents ?? new Map();
}

export function forgetOwnership(stateDir: string, runId: string): void {
  rmSync(ledgerFile(stateDir, runId), { force: true });
}

/** Run ids that have a record. */
export function ownedRuns(stateDir: string): string[] {
  try {
    return readdirSync(ownedDir(stateDir)).flatMap((name) => {
      const runId = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : '';
      return RUN_ID_PATTERN.test(runId) ? [runId] : [];
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
  /** Created documents Linear no longer has (deleted for good by a scenario): nothing left to clean up. */
  gone: number;
  /**
   * Documents a scenario trashed in a run project that was already deleted: outside every team zone, so they do
   * not count against a zone's cap, and Linear purges them; left as they are.
   */
  trashedInDeletedProjects: number;
  /** What recovery could not do or could not verify; the run is recovered only when this is empty. */
  problems: string[];
}

type Reader = Pick<LinearWorld, 'projects' | 'deleteProject' | 'archiveRunTeamDocuments'> & { client: Pick<LinearWorld['client'], 'getDocuments' | 'restoreDocument'> & Partial<Pick<LinearWorld['client'], 'stopped'>> };

/**
 * Finishes a run's cleanup from its record alone, then checks the result.
 *
 * Before any change it reads every recorded document and project and refuses,
 * changing nothing, when one is not the run's: a project whose name is no
 * project of the run, or a live document outside the run's projects and team
 * zones. Then it restores the documents a scenario trashed in a recorded
 * project that still exists, so the project's deletion archives them; deletes
 * each recorded project that still exists, once; and
 * archives the recorded documents left live (or trashed) in a team zone
 * through a project of the run, which is recorded too. Last it reads again:
 * every created document must be archived and not trashed (or gone for good,
 * or trashed in a project deleted before), and no project of the run may be
 * left. A project Linear once answered it deleted is never
 * deleted again: a stale read that still lists it is reported, not hidden.
 */
export async function recoverOwned(
  world: Reader,
  owned: Ownership,
  ledger: Pick<OwnershipLedger, 'project' | 'projectDeleted' | 'stateDir'>,
  /** Live team-zone documents titled with the run's prefix that its record may lack; archived and checked too. */
  named: ReadonlyArray<LinearDocument> = [],
): Promise<Recovery> {
  const { runId } = owned;
  const recovery: Recovery = { runId, deletedProjects: [], archivedDocuments: 0, alreadyArchived: 0, verifiedArchived: 0, gone: 0, trashedInDeletedProjects: 0, problems: [] };

  for (const [id, name] of owned.projects) {
    if (runOfProject(name) !== runId) throw new OwnershipRefusal(`refusing to recover run ${runId}: project ${id} (${name}) is not a project of the run`);
  }
  // Recorded projects are found by id, whatever they are called now: a renamed one is refused, not missed.
  const existing = (await world.projects()).filter((project) => owned.projects.has(project.id));
  for (const project of existing) {
    if (project.name !== owned.projects.get(project.id)) throw new OwnershipRefusal(`refusing to recover run ${runId}: project ${project.id} is named ${project.name}, recorded as ${owned.projects.get(project.id)}`);
  }

  const ids = [...owned.documents.keys()];
  const byName = named.map((document) => document.id).filter((id) => !owned.documents.has(id));
  const before = await world.client.getDocuments(ids);
  const zone: LinearDocument[] = [];
  const toRestore: LinearDocument[] = [];
  const foreign: string[] = [];
  const live = new Set(existing.map((project) => project.id));
  for (const document of before) {
    if (document.archivedAt !== null && !document.trashed) {
      recovery.alreadyArchived += 1;
    } else if (document.projectId !== null) {
      if (!owned.projects.has(document.projectId)) foreign.push(`document ${document.id} is in project ${document.projectId}, which is not the run's`);
      else if (document.trashed && live.has(document.projectId)) toRestore.push(document);
    } else if (document.teamId !== null && owned.teamIds.has(document.teamId)) {
      zone.push(document);
    } else {
      foreign.push(`document ${document.id} is in team ${document.teamId ?? 'none'}, outside the run's team zones`);
    }
  }
  if (foreign.length > 0) throw new OwnershipRefusal(`refusing to recover run ${runId}: ${foreign.join('; ')}`);
  for (const document of named) {
    if (runOfTeamTitle(document.title) !== runId || document.projectId !== null) throw new OwnershipRefusal(`refusing to recover run ${runId}: document ${document.id} is not a team-zone document of the run`);
    if (!zone.some((known) => known.id === document.id) && !owned.documents.has(document.id)) zone.push(document);
  }

  for (const document of toRestore) {
    try {
      await world.client.restoreDocument(document.id);
    } catch (error) {
      recovery.problems.push(`restoring document ${document.id}: ${(error as Error).message}`);
    }
  }
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
        (document) => owned.documents.has(document.id) || runOfTeamTitle(document.title) === runId,
        ledger,
      );
    } catch (error) {
      recovery.problems.push(`team-zone documents: ${(error as Error).message}`);
    }
  }

  // The proof: read everything again.
  const canRetry = () => world.client.stopped === undefined;
  const after = new Map((await retryCleanup(() => world.client.getDocuments([...ids, ...byName]), undefined, canRetry)).map((document) => [document.id, document]));
  const projectsNow = await retryCleanup(() => world.projects(), undefined, canRetry);
  const listed = new Set(projectsNow.map((project) => project.id));
  for (const [id, confirmed] of [...owned.documents, ...byName.map((id) => [id, true] as const)]) {
    const document = after.get(id);
    if (document === undefined) {
      // Never created (only asked for), or deleted for good by a scenario: nothing to clean up.
      if (confirmed) recovery.gone += 1;
    } else if (document.trashed && document.projectId !== null && !listed.has(document.projectId)) {
      recovery.trashedInDeletedProjects += 1;
    } else if (document.trashed) {
      recovery.problems.push(`document ${id} is trashed`);
    } else if (document.archivedAt === null) {
      recovery.problems.push(`document ${id} is not archived`);
    } else {
      recovery.verifiedArchived += 1;
    }
  }
  // The record is read again too: an archive project made just now is the run's. Recorded projects count by id,
  // others of the run by name.
  const now = readOwnership(ledger.stateDir, runId)?.projects ?? owned.projects;
  const left = projectsNow.filter((project) => now.has(project.id) || runOfProject(project.name) === runId);
  for (const project of left) {
    recovery.problems.push(now.has(project.id)
      ? `project ${project.name} is still there`
      : `project ${project.name} (${project.id}) of the run is not in its record; left as it is`);
  }
  return recovery;
}

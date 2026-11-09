// Step one of a run: read Linear's changes, scan them, then record and push
// accepted content and its identities in one atomic transaction.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMapping } from '../mapping/index.ts';
import { splitFile } from '../format/index.ts';
import { type LinearDocument } from '../linear/index.ts';
import { annotatedPlaces, placeId, type InitialSyncPlan } from '../initial-sync/plan.ts';
import { type BodyTransform, restoreBody } from '../initial-sync/transform.ts';
import { type RunContext } from '../run/preflight.ts';
import { type CommitIdentity, type StateConfig, type FetchedState, type Oid, commitTree, commitIds, commitUploads, pushAtomic, stateRef, listTree, readBlobs, readIds, readUploads } from '../state/index.ts';
import { SYNC_IDENTITY } from '../initial-sync/confirm.ts';
import { securityGate, type SecurityGate, type SecurityFinding } from './security.ts';
import { documentPath } from './paths.ts';
import { captureAssets } from './assets.ts';

export interface CaptureOptions {
  config: StateConfig;
  identity?: CommitIdentity;
  transforms?: readonly BodyTransform[];
  security?: SecurityGate;
  fetch?: typeof fetch;
}

export interface CaptureResult {
  ok: boolean;
  code?: 'state-moved';
  fetched: FetchedState;
  /** Exact records seen during capture, for the writer's re-read comparison. Never serialize these. */
  documents: Map<string, LinearDocument>;
  blocked: Array<{ id: string; path: string; findings: SecurityFinding[] }>;
  changed: string[];
  removed: string[];
  leftOut: Array<{ id: string; rule: string }>;
  summary: string;
}

const CURSOR = /^Capture-through: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)$/m;

/** Cursor is in ids history, so ordinary id commits by later steps cannot erase it. */
async function readCursor(context: RunContext): Promise<string | null> {
  if (context.fetched.state.ids === null) return null;
  const log = await context.git.text(['log', '--format=%B', '--grep=^Capture-through:', '-1', context.fetched.state.ids]);
  return CURSOR.exec(log)?.[1] ?? null;
}

export async function capture(context: RunContext, options: CaptureOptions): Promise<CaptureResult> {
  const { git, linear, fetched, mapping, targets } = context;
  const base = fetched.state.linear;
  if (base === null) throw new Error('run initial sync first');
  const identity = options.identity ?? SYNC_IDENTITY;
  const ids = await readIds(git, fetched.state.ids);
  const uploads = await readUploads(git, fetched.state.uploads);
  const gate = options.security ?? await securityGate(git, fetched.tracked);
  const cursor = await readCursor(context);
  const entries = await listTree(git, base);
  const blobs = await readBlobs(git, entries.filter((entry) => entry.type === 'blob').map((entry) => entry.oid));
  const previous = new Map(entries.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, blobs.get(entry.oid)!]));
  const byId = new Map([...ids].map(([path, entry]) => [entry.id, { path, entry }]));
  const listed = new Map<string, LinearDocument>();
  const folders = new Map<string, string>();
  for (const { place, folder } of annotatedPlaces(mapping.zones)) {
    const resolved = placeId(targets, place);
    folders.set('projectId' in resolved ? `project:${resolved.projectId}` : `team:${resolved.teamId}`, folder);
    for (const document of await linear.listDocuments(resolved, { includeArchived: true })) listed.set(document.id, document);
  }
  // Looking up known ids also finds trash, project moves and moves out of scope.
  const missing = [...byId.keys()].filter((id) => !listed.has(id));
  for (const document of await linear.getDocuments(missing)) listed.set(document.id, document);
  const folderFor = (doc: LinearDocument) => folders.get(doc.projectId !== null ? `project:${doc.projectId}` : `team:${doc.teamId}`);
  const live = (doc: LinearDocument) => !doc.trashed && doc.archivedAt === null && folderFor(doc) !== undefined;
  const normalizedTime = (doc: LinearDocument) => {
    const time = new Date(doc.updatedAt);
    if (!Number.isFinite(time.getTime())) throw new Error('a document has an invalid update time');
    return time.toISOString();
  };
  const selected = [...listed.values()].filter((doc) => !byId.has(doc.id) || byId.get(doc.id)?.entry.saved !== undefined || cursor === null || normalizedTime(doc) >= cursor);
  const documents = new Map<string, LinearDocument>(listed);
  const work = new Map<string, LinearDocument>();
  for (const doc of await linear.getDocuments(selected.filter(live).map((doc) => doc.id), { withContent: true })) { documents.set(doc.id, doc); work.set(doc.id, doc); }
  // Keep metadata for out-of-scope documents; never infer deletion from a missing page.
  for (const doc of selected) if (!live(doc)) work.set(doc.id, doc);
  const result: CaptureResult = { ok: true, fetched, documents, blocked: [], changed: [], removed: [], leftOut: [], summary: '' };
  const changes = new Map<string, Buffer | string | null>();
  const occupied = new Set(previous.keys());
  const transforms = options.transforms ?? [];
  const captureMapping = await loadMapping(git, base);
  const plan: InitialSyncPlan = { create: [], overwrite: [], trash: [], leftOut: [] };
  for (const file of captureMapping.documents) {
    const entry = ids.get(file.path);
    if (entry === undefined) plan.create.push({ path: file.path, title: file.title, place: file.place });
    else plan.overwrite.push({ path: file.path, title: file.title, place: file.place, documentId: entry.id });
  }
  const documentIds = new Map([...ids].map(([path, entry]) => [path, entry.id]));
  const paths = new Map<string, string>();
  const reservations = new Set(occupied);
  for (const doc of [...work.values()].filter(live).sort((a, b) => a.id.localeCompare(b.id))) {
    const old = byId.get(doc.id);
    const available = new Set(reservations);
    if (old !== undefined) available.delete(old.path);
    const path = documentPath(folderFor(doc)!, doc.title, doc.id, available);
    paths.set(doc.id, path);
    reservations.add(path);
    if (old !== undefined) documentIds.delete(old.path);
    documentIds.set(path, doc.id);
  }
  for (const transform of transforms) await transform.prepare?.({ git, tracked: base, linear, plan, uploads, documentIds });

  for (const doc of [...work.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const old = byId.get(doc.id);
    if (!live(doc)) {
      if (old !== undefined) {
        changes.set(old.path, null);
        ids.delete(old.path);
        occupied.delete(old.path);
        result.removed.push(old.path);
      }
      continue;
    }
    const path = paths.get(doc.id)!;
    const head = old === undefined ? '' : splitFile(previous.get(old.path)?.toString('utf8') ?? '').head;
    try {
      const restored = restoreBody(transforms, path, doc.content ?? '');
      const assets = await captureAssets(git, options.config, base, path, restored, uploads, options.fetch);
      const files = new Map<string, Buffer | string>([[path, head + assets.body], ...assets.files]);
      const findings = await gate.check(files);
      if (findings.length > 0) {
        // Save the original appearance durably before setting the mark. A failed
        // mark or comment can then be retried without forgetting the original.
        const saved = old?.entry.saved ?? { icon: doc.icon, color: doc.color };
        const blockedPath = old?.path ?? path;
        ids.set(blockedPath, { id: doc.id, saved });
        result.blocked.push({ id: doc.id, path: blockedPath, findings });
        continue;
      }
      if (old?.entry.saved !== undefined) await linear.updateDocument(doc.id, old.entry.saved);
      if (old !== undefined && old.path !== path) {
        changes.set(old.path, null);
        ids.delete(old.path);
        occupied.delete(old.path);
        result.removed.push(old.path);
      }
      ids.set(path, { id: doc.id });
      occupied.add(path);
      for (const [file, content] of files) {
        const existing = previous.get(file);
        if (existing === undefined || !existing.equals(Buffer.from(content))) { changes.set(file, content); result.changed.push(file); }
      }
      for (const [hash, url] of assets.uploads) uploads.set(hash, url);
    } catch {
      // Do not expose asset URLs, document content, or transform errors.
      result.leftOut.push({ id: doc.id, rule: 'capture-translation' });
    }
  }
  // Advance only to timestamps actually observed; equality is reread next run
  // so documents sharing a timestamp or edited during pagination are not lost.
  const through = result.leftOut.length > 0 ? cursor : [...listed.values()].map(normalizedTime).sort().at(-1) ?? cursor;
  const message = through === null ? 'Capture document ids' : `Capture document ids\n\nCapture-through: ${through}`;
  const idsCommit = await commitIds(git, fetched.state.ids, ids, identity, { message, always: through !== cursor });
  const uploadsCommit = await commitUploads(git, fetched.state.uploads, uploads, identity);
  const prepared = await prepareLfs(git, fetched.tracked, changes);
  const linearCommit = await commitTree(git, { parents: [base], base, changes: prepared.changes, message: 'Capture Linear changes', identity });
  // Upload accepted LFS objects before publishing pointers; no blocked bytes reach this step.
  if (prepared.oids.length > 0) await git.run(['lfs', 'push', '--object-id', options.config.remote, ...prepared.oids]);
  const next = { linear: linearCommit, ids: idsCommit, uploads: uploadsCommit };
  const pushed = await pushAtomic(git, options.config, (['linear', 'ids', 'uploads'] as const).map((store) => ({ ref: stateRef(options.config, store), expected: fetched.state[store], next: next[store] })));
  if (!pushed.ok) { result.ok = false; result.code = 'state-moved'; }
  else {
    result.fetched = { ...fetched, state: next };
    for (const blocked of result.blocked) {
      const doc = documents.get(blocked.id)!;
      if (doc.icon !== 'Cross' || doc.color !== '#EB5757') await linear.updateDocument(doc.id, { icon: 'Cross', color: '#EB5757' });
      if (doc.documentContentId !== null && byId.get(doc.id)?.entry.saved === undefined) {
        const details = blocked.findings.map(({ hook, line }) => `hook \`${hook}\`, line ${line}`).join('; ');
        await linear.commentOnDocument(doc.documentContentId, `A security check blocked this change: ${details}. Edit the document to fix it; the next run will try again.`);
      }
    }

  }
  result.summary = `Captured ${result.changed.length} files; removed ${result.removed.length}; blocked ${result.blocked.length}; left out ${result.leftOut.length}.`;
  if (!gate.configured) result.summary += '\nContent is pushed unchecked: no security hooks are configured.';
  return result;
}

/** Apply only LFS, after the security gate. Other clean filters cannot change captured text. */
async function prepareLfs(git: RunContext['git'], tracked: Oid, changes: Map<string, Buffer | string | null>) {
  const dir = await mkdtemp(join(tmpdir(), 'capture-attributes-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  const result = new Map(changes);
  const oids: string[] = [];
  try {
    await git.run(['read-tree', tracked], { env });
    for (const [path, content] of changes) {
      if (content === null) continue;
      const attributes = await git.run(['check-attr', '--cached', '-z', '--stdin', 'filter'], { input: `${path}\0`, env });
      if (attributes.stdout.toString('utf8').split('\0')[2] !== 'lfs') continue;
      const cleaned = await git.run(['lfs', 'clean', '--', path], { input: content });
      const hash = /\noid sha256:([a-f0-9]{64})\n/.exec(cleaned.stdout.toString('utf8'))?.[1];
      if (hash === undefined) throw new Error('LFS did not return a pointer');
      oids.push(hash);
      result.set(path, cleaned.stdout);
    }
    return { changes: result, oids: [...new Set(oids)] };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

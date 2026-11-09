// Step one of a run: read Linear's changes, scan them, then record and push
// accepted content and its identities in one atomic transaction.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nearestZone, folderOf } from '../mapping/annotations.ts';
import { splitFile } from '../format/index.ts';
import { type LinearDocument } from '../linear/index.ts';
import { documentUrlBase, linksFromLinear, linksToLinear, workspaceUrlKey, type LinkSpellings } from '../initial-sync/links.ts';
import { annotatedPlaces, placeId } from '../initial-sync/plan.ts';
import { type RunContext } from '../run/preflight.ts';
import { type CommitIdentity, type StateConfig, type StateSnapshot, type Oid, commitTree, commitIds, commitUploads, pushAtomic, stateRef, listTree, readBlobs, readIds, readReservedIds, readUploads } from '../state/index.ts';
import { SYNC_IDENTITY } from '../initial-sync/confirm.ts';
import { securityGate, type SecurityGate, type SecurityFinding } from './security.ts';
import { reconcileDocumentMark } from './marks.ts';
import { documentPath } from './paths.ts';
import { createAssetCapture, type CapturedAssets } from './assets.ts';

export interface CaptureOptions {
  config: StateConfig;
  /** The state refs left by the previous step, used as push leases. */
  state: StateSnapshot;
  identity?: CommitIdentity;
  security?: SecurityGate;
  fetch?: typeof fetch;
}

export interface CaptureResult {
  ok: boolean;
  code?: 'state-moved';
  /** The state refs after capture, or the input snapshot if its push lost the lease. */
  state: StateSnapshot;
  /** Metadata for every observed document; selected changes also have content. Never serialize these. */
  documents: Map<string, LinearDocument>;
  blocked: Array<{ id: string; path: string; findings: SecurityFinding[] }>;
  changed: string[];
  removed: string[];
  leftOut: Array<{ id: string; rule: string }>;
  summary: string;
}

const CURSOR = /^Capture-through: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)$/m;

/** Cursor is in ids history, so ordinary id commits by later steps cannot erase it. */
async function readCursor(context: RunContext, state: StateSnapshot): Promise<string | null> {
  if (state.ids === null) return null;
  const log = await context.git.text(['log', '--format=%B', '--grep=^Capture-through:', '-1', state.ids]);
  return CURSOR.exec(log)?.[1] ?? null;
}

export async function capture(context: RunContext, options: CaptureOptions): Promise<CaptureResult> {
  const { git, linear, fetched, mapping, targets } = context;
  const state = { ...options.state };
  const base = state.linear;
  if (base === null) throw new Error('run initial sync first');
  const identity = options.identity ?? SYNC_IDENTITY;
  const ids = await readIds(git, state.ids);
  const uploads = await readUploads(git, state.uploads);
  const reserved = await readReservedIds(git, state.ids);
  const gate = options.security ?? await securityGate(git, fetched.tracked);
  try {
    const cursor = await readCursor(context, state);
    const entries = await listTree(git, base);
    const textEntries = entries.filter((entry) => entry.type === 'blob' && ids.has(entry.path));
    const blobs = await readBlobs(git, textEntries.map((entry) => entry.oid));
    const previous = new Map(textEntries.map((entry) => [entry.path, blobs.get(entry.oid)!]));
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
    let selected = [...listed.values()].filter((doc) => !byId.has(doc.id) || byId.get(doc.id)?.entry.saved !== undefined || cursor === null || normalizedTime(doc) >= cursor);
    const invalidZone = (doc: LinearDocument, path: string) => {
      const zone = nearestZone(mapping.zones, folderOf(path));
      if (zone === undefined) return true;
      const place = zone.project === undefined ? {kind: 'team' as const, team: zone.team} : {kind: 'project' as const, team: zone.team, project: zone.project};
      const target = placeId(targets, place);
      return 'projectId' in target ? target.projectId !== doc.projectId : doc.projectId !== null || target.teamId !== doc.teamId;
    };
    const destination = (doc: LinearDocument, occupied: ReadonlySet<string>) => {
      const old = byId.get(doc.id);
      const available = new Set(occupied);
      if (old !== undefined) available.delete(old.path);
      return documentPath(folderFor(doc)!, doc.title, doc.id, available, old?.path, (path) => invalidZone(doc, path));
    };
    // An unchanged source may link a renamed, moved or removed target.
    // Re-read bodies when a path changes so those inbound links are translated too.
    if ([...listed.values()].some((doc) => {
      const old = byId.get(doc.id);
      return old !== undefined && (!live(doc) || destination(doc, new Set(entries.map((entry) => entry.path))) !== old.path);
    })) selected = [...listed.values()];
    const documents = new Map<string, LinearDocument>(listed);
    const work = new Map<string, LinearDocument>();
    for (const doc of await linear.getDocuments(selected.filter(live).map((doc) => doc.id), { withContent: true })) { documents.set(doc.id, doc); work.set(doc.id, doc); }
    // Keep metadata for out-of-scope documents; never infer deletion from a missing page.
    for (const doc of selected) if (!live(doc)) work.set(doc.id, doc);
    const result: CaptureResult = { ok: true, state, documents, blocked: [], changed: [], removed: [], leftOut: [], summary: '' };
    const changes = new Map<string, Buffer | string | null>();
    const occupied = new Set(entries.map((entry) => entry.path));
    // Only files already present in the branch are link targets until their
    // candidates pass. A blocked rename continues to point at its old file.
    const documentIds = new Map([...ids].filter(([path]) => previous.has(path)).map(([path, entry]) => [path, entry.id]));
    const paths = new Map<string, string>();
    const reservations = new Set(occupied);
    for (const doc of [...work.values()].filter(live).sort((a, b) => a.id.localeCompare(b.id))) {
      const old = byId.get(doc.id);
      const path = destination(doc, reservations);
      paths.set(doc.id, path);
      reservations.add(path);
    }
    const linkBase = [...work.values()].some((doc) => doc.content?.includes('https://linear.app/')) ? documentUrlBase(await workspaceUrlKey(linear)) : undefined;
    const downloadAssets = createAssetCapture(git, options.config, base, options.fetch ?? ((input, init) => linear.transport.fetchUpload(String(input), init)));
    type Candidate = { doc: LinearDocument; path: string; head: string; previousBody?: string; assets: CapturedAssets; files: Map<string, Buffer | string>; checked?: string };
    const candidates = new Map<string, Candidate>();
    const resetTarget = (id: string) => {
      for (const [path, target] of documentIds) if (target === id) documentIds.delete(path);
      const old = byId.get(id);
      if (old !== undefined && previous.has(old.path)) documentIds.set(old.path, id);
    };
    for (const doc of [...work.values()].sort((a,b) => a.id.localeCompare(b.id))) {
      const old = byId.get(doc.id);
      if (!live(doc)) {
        if (old !== undefined) {
          if (old.entry.saved !== undefined) await linear.updateDocument(doc.id, {icon: old.entry.saved.icon, color: old.entry.saved.color});
          changes.set(old.path, null);
          ids.delete(old.path);
          documentIds.delete(old.path);
          result.removed.push(old.path);
        }
        continue;
      }
      const path = paths.get(doc.id)!;
      const prior = splitFile(old === undefined ? '' : previous.get(old.path)?.toString('utf8') ?? '');
      try {
        const assets = await downloadAssets(path, doc.content ?? '', uploads, old === undefined ? undefined : prior.body, old?.path);
        const candidate: Candidate = {doc, path, head: prior.head, assets, files: new Map<string, Buffer | string>([[path, prior.head + assets.body], ...assets.files])};
        if (old?.path === path) candidate.previousBody = prior.body;
        candidates.set(doc.id, candidate);
        resetTarget(doc.id);
        if (old !== undefined) documentIds.delete(old.path);
        documentIds.set(path, doc.id);
      } catch {
        result.leftOut.push({id: doc.id, rule: 'capture-translation'});
      }
    }
    // A rejected target may change other documents' relative links. Recheck
    // only bodies that change as targets fall back to their accepted paths.
    let again = true;
    while (again) {
      again = false;
      for (const [id, candidate] of candidates) {
        const {doc, path, head, assets} = candidate;
        const old = byId.get(id);
        let body = assets.body;
        if (linkBase !== undefined) {
          const map = {base: linkBase, ids: new Map(documentIds)};
          const seen: LinkSpellings = new Map();
          if (candidate.previousBody !== undefined) linksToLinear(candidate.previousBody, path, map, seen);
          body = linksFromLinear(body, path, map, seen);
        }
        const text = head + body;
        candidate.files.set(path, text);
        if (candidate.checked === text) continue;
        const unchanged = old?.path === path && previous.get(path)?.equals(Buffer.from(text)) === true && assets.files.size === 0 && assets.uploads.size === 0;
        let findings: SecurityFinding[] = [];
        if (!unchanged || old?.entry.saved !== undefined) {
          // Upload URLs also enter the cache ref. Scan the original text so
          // localization cannot hide a secret embedded in a URL or its query.
          const original = head + (doc.content ?? '');
          if (original !== text) findings = await gate.check(new Map<string, Buffer | string>([[path, original], ...assets.files]));
          if (findings.length === 0) findings = await gate.check(candidate.files);
        }
        if (findings.length > 0) {
          const saved = old?.entry.saved ?? {icon: doc.icon, color: doc.color};
          ids.set(old?.path ?? path, {id, saved});
          result.blocked.push({id, path: old?.path ?? path, findings});
          candidates.delete(id);
          resetTarget(id);
          again = true;
          break;
        }
        candidate.checked = text;
      }
    }
    for (const [id, candidate] of candidates) {
      const old = byId.get(id);
      if (old !== undefined && old.path !== candidate.path) {
        changes.set(old.path, null);
        ids.delete(old.path);
        result.removed.push(old.path);
      }
      ids.set(candidate.path, old?.entry ?? {id});
      for (const [path, content] of candidate.files) {
        if (previous.get(path)?.equals(Buffer.from(content)) !== true) {
          changes.set(path, content);
          result.changed.push(path);
        }
      }
      for (const [hash,url] of candidate.assets.uploads) uploads.set(hash,url);
    }
    // Advance only to timestamps actually observed; equality is reread next run
    // so documents sharing a timestamp or edited during pagination are not lost.
    const through = result.leftOut.length > 0 ? cursor : [...listed.values()].map(normalizedTime).sort().at(-1) ?? cursor;
    const message = through === null ? 'Capture document ids' : `Capture document ids\n\nCapture-through: ${through}`;
    const idsCommit = await commitIds(git, state.ids, ids, identity, { message, always: through !== cursor, reserved });
    const uploadsCommit = await commitUploads(git, state.uploads, uploads, identity);
    const prepared = await prepareLfs(git, fetched.tracked, changes);
    const linearCommit = await commitTree(git, { parents: [base], base, changes: prepared.changes, message: 'Capture Linear changes', identity });
    // Upload accepted LFS objects before publishing pointers; no blocked bytes reach this step.
    if (prepared.oids.length > 0) await git.run(['lfs', 'push', '--object-id', options.config.remote, ...prepared.oids]);
    const next = { linear: linearCommit, ids: idsCommit, uploads: uploadsCommit };
    const pushed = await pushAtomic(git, options.config, (['linear', 'ids', 'uploads'] as const).map((store) => ({ ref: stateRef(options.config, store), expected: state[store], next: next[store] })));
    if (!pushed.ok) { result.ok = false; result.code = 'state-moved'; }
    else {
      result.state = next;
      const lostLease = new Error('state moved while recording document marks');
      const marked = [
        ...[...candidates.values()].map(({doc, path}) => ({doc, path, blocked: [] as SecurityFinding[]})),
        ...result.blocked.map(({id, path, findings}) => ({doc: documents.get(id)!, path, blocked: findings})),
      ];
      try {
        for (const {doc, path, blocked} of marked) {
          await reconcileDocumentMark({document: doc, entry: ids.get(path)!, linear, blocked,
            persistEntry: async (entry) => {
              ids.set(path, entry);
              const tip = await commitIds(git, result.state.ids, ids, identity, {reserved, message:'Capture document marks'});
              const updated = {...next, ids:tip};
              const saved = await pushAtomic(git, options.config, (['linear', 'ids', 'uploads'] as const).map((store) => ({ref:stateRef(options.config, store), expected:result.state[store], next:updated[store]})));
              if (!saved.ok) { result.ok = false; result.code = 'state-moved'; throw lostLease; }
              result.state = updated;
            },
          });
        }
      } catch (error) {
        if (error !== lostLease) throw error;
      }

    }
    result.summary = `Captured ${result.changed.length} files; removed ${result.removed.length}; blocked ${result.blocked.length}; left out ${result.leftOut.length}.`;
    if (!gate.configured) result.summary += '\nContent is pushed unchecked: no security hooks are configured.';
    return result;
  } finally { await gate.close?.(); }
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

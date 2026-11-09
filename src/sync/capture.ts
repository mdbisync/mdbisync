// Step one of a run: read Linear's changes, scan them, then record and push
// accepted content and its identities in one atomic transaction.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { isMap, parseDocument, stringify } from 'yaml';
import { loadMapping, readAnnotation, findFrontMatter, TEAM_KEY, PROJECT_KEY } from '../mapping/index.ts';
import { resolveTargets } from '../setup/linear.ts';
import { nearestZone, folderOf } from '../mapping/annotations.ts';
import { lintText, splitFile } from '../format/index.ts';
import { type LinearDocument, type StopReason, LinearError, LinearStoppedError, describeLinearError, isTransientLinearError } from '../linear/index.ts';
import { renderStop } from '../run/stop.ts';
import { documentUrlBase, linksFromLinear, linksToLinear, workspaceUrlKey, type LinkSpellings } from '../initial-sync/links.ts';
import { annotatedPlaces, placeId } from '../initial-sync/plan.ts';
import { type RunContext } from '../run/preflight.ts';
import { type CommitIdentity, type StateConfig, type StateSnapshot, type Oid, commitTree, commitIds, commitUploads, pushAtomic, stateRef, listTree, readBlobs, readIds, readReservedIds, readUploads } from '../state/index.ts';
import { SYNC_IDENTITY } from '../initial-sync/confirm.ts';
import { securityGate, type SecurityGate, type SecurityFinding } from './security.ts';
import { reconcileDocumentMark } from './marks.ts';
import { documentPath } from './paths.ts';
import { lastSynchronized } from './merge.ts';
import { lengthRefusal } from '../linear/index.ts';
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
  code?: 'state-moved' | 'stopped' | 'linear-failed';
  /** Linear failed a request (a server error, a lost connection, an error answer): its operation and error, no content. */
  failure?: { operation: string; error: string };
  /** A resumable client budget stop; state is the last successful push. */
  stopped?: StopReason;
  /** The state refs after capture, or the input snapshot if its push lost the lease. */
  state: StateSnapshot;
  /** Metadata for every observed document; selected changes also have content. Never serialize these. */
  documents: Map<string, LinearDocument>;
  blocked: Array<{ id: string; path: string; findings: SecurityFinding[] }>;
  changed: string[];
  removed: string[];
  leftOut: Array<{ id: string; rule: string }>;
  /** Captured content that exceeds Linear's write limit; paths and counts only. */
  writeBackWarnings: Array<{ path: string; code: 'linear-content-too-large-to-write-back'; length: number; limit: number }>;
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
  const {git, linear, fetched} = context;
  let mapping = context.mapping;
  let targets = context.targets;
  const state = { ...options.state };
  const base = state.linear;
  if (base === null) throw new Error('run initial sync first');
  const identity = options.identity ?? SYNC_IDENTITY;
  const ids = await readIds(git, state.ids);
  const uploads = await readUploads(git, state.uploads);
  const reserved = await readReservedIds(git, state.ids);
  const gate = options.security ?? await securityGate(git, fetched.tracked);
  const result: CaptureResult = {ok:true, state, documents:new Map(), blocked:[], changed:[], removed:[], leftOut:[], writeBackWarnings:[], summary:''};
  let published = false;
  try {
    // Capture the old place before a git annotation change moves its documents.
    const recorded = await loadMapping(git, base);
    const zones = new Map(mapping.zones);
    let changedPlace = false;
    for (const [folder, old] of recorded.zones) {
      const current = zones.get(folder);
      if (current !== undefined && (old.team !== current.team || old.project !== current.project)) {
        zones.set(folder, old);
        changedPlace = true;
      }
    }
    if (changedPlace) {
      mapping = {...mapping, zones};
      const resolved = await resolveTargets(linear, zones.values());
      if (resolved.targets === undefined) throw new Error('the previously recorded document places could not be resolved');
      targets = resolved.targets;
    }
    const cursor = await readCursor(context, state);
    const entries = await listTree(git, base);
    const textEntries = entries.filter((entry) => entry.type === 'blob' && ids.has(entry.path));
    const blobs = await readBlobs(git, textEntries.map((entry) => entry.oid));
    const previous = new Map(textEntries.map((entry) => [entry.path, blobs.get(entry.oid)!]));
    const byId = new Map([...ids].map(([path, entry]) => [entry.id, { path, entry }]));
    // A new document's id is reserved for its path until it is mapped. Documents an earlier run wrote may link to it, and
    // its create may have landed with the answer lost: the reserved path is where it belongs.
    const reservedById = new Map([...reserved].filter(([path, id]) => !ids.has(path) && !byId.has(id)).map(([path, id]) => [id, path]));
    const occupied = new Set([...entries.map((entry) => entry.path), ...ids.keys()]);
    const annotationHead = (path: string): string | undefined => {
      if (posix.basename(path) !== 'README.md' || !mapping.zones.has(folderOf(path))) return undefined;
      const prior = previous.get(path)?.toString('utf8');
      if (prior === undefined) return undefined;
      const read = readAnnotation(path, prior);
      return 'annotation' in read && read.annotation !== null ? splitFile(prior).head : undefined;
    };
    const listed = new Map<string, LinearDocument>();
    const folders = new Map<string, string>();
    const places = annotatedPlaces(mapping.zones).map(({place, folder}) => {
      const resolved = placeId(targets, place);
      folders.set('projectId' in resolved ? `project:${resolved.projectId}` : `team:${resolved.teamId}`, folder);
      return resolved;
    });
    for (const document of await linear.listDocumentsInPlaces(places, {includeArchived:true})) listed.set(document.id, document);
    // Looking up known ids also finds trash, project moves and moves out of scope.
    const missing = [...byId.keys()].filter((id) => !listed.has(id));
    for (const document of await linear.getDocuments(missing)) listed.set(document.id, document);
    // Git-only exclusions keep their last accepted identity and place. A
    // collision or an annotation recorded for other files is not a Linear move.
    const baselines = new Map<string, Awaited<ReturnType<typeof lastSynchronized>>>();
    const excludedPath = (path: string) => {
      const mapped = recorded.documents.find((document) => document.path === path);
      const prior = previous.get(path);
      return mapped === undefined || (prior !== undefined && lintText(path, prior.toString('utf8')).length > 0)
        || lengthRefusal({title: mapped.title}, linear.facts) !== undefined;
    };
    const retained = new Map<string, string>();
    for (const [id, old] of byId) {
      if (!excludedPath(old.path)) continue;
      const baseline = await lastSynchronized(git, base, old.path, linear.facts);
      baselines.set(old.path, baseline);
      const doc = listed.get(id);
      if (baseline === null || doc === undefined || doc.title.normalize('NFC') !== baseline.file.title.normalize('NFC')) continue;
      let resolved;
      try { resolved = placeId(targets, baseline.file.place); }
      catch {
        const place = baseline.file.place;
        const lookup = await resolveTargets(linear, [{team:place.team, teamFolder:'', ...(place.kind === 'project' ? {project:place.project, projectFolder:''} : {})}]);
        if (lookup.targets === undefined) continue;
        resolved = placeId(lookup.targets, place);
      }
      if ('projectId' in resolved ? resolved.projectId === doc.projectId : doc.projectId === null && resolved.teamId === doc.teamId) retained.set(id, old.path);
    }
    const folderFor = (doc: LinearDocument) => folders.get(doc.projectId !== null ? `project:${doc.projectId}` : `team:${doc.teamId}`);
    const live = (doc: LinearDocument) => !doc.trashed && doc.archivedAt === null && (folderFor(doc) !== undefined || retained.has(doc.id));
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
    const destination = (doc: LinearDocument, occupied: ReadonlySet<string>, allocated: ReadonlyMap<string, string> = new Map()) => {
      if (retained.has(doc.id)) return retained.get(doc.id)!;
      const own = reservedById.get(doc.id);
      if (own !== undefined && !occupied.has(own) && !allocated.has(own) && !invalidZone(doc, own)) return own;
      const old = byId.get(doc.id);
      const available = new Set(occupied);
      if (old !== undefined && (!allocated.has(old.path) || allocated.get(old.path) === doc.id)) available.delete(old.path);
      return documentPath(folderFor(doc)!, doc.title, doc.id, available, old?.path, (path) => invalidZone(doc, path));
    };
    // An unchanged source may link a renamed, moved or removed target.
    // Re-read bodies when a path changes so those inbound links are translated too.
    if ([...listed.values()].some((doc) => {
      const old = byId.get(doc.id);
      return old !== undefined && (!live(doc) || destination(doc, occupied) !== old.path);
    })) selected = [...listed.values()];
    const documents = new Map<string, LinearDocument>(listed);
    const work = new Map<string, LinearDocument>();
    for (const doc of await linear.getDocuments(selected.filter(live).map((doc) => doc.id), { withContent: true })) { documents.set(doc.id, doc); work.set(doc.id, doc); }
    // Keep metadata for out-of-scope documents; never infer deletion from a missing page.
    for (const doc of selected) if (!live(doc)) work.set(doc.id, doc);
    result.documents = documents;
    const changes = new Map<string, Buffer | string | null>();
    const removeBody = (path: string) => changes.set(path, annotationHead(path) ?? null);
    // Only files already present in the branch are link targets until their
    // candidates pass. A blocked rename continues to point at its old file.
    const documentIds = new Map([...ids].filter(([path]) => previous.has(path)).map(([path, entry]) => [path, entry.id]));
    // A reserved id names its path too: a link written to a new document that is not created yet stays relative.
    for (const [id, path] of reservedById) if (!documentIds.has(path)) documentIds.set(path, id);
    const paths = new Map<string, string>();
    const reservations = new Set(occupied);
    const allocated = new Map<string, string>();
    const reservedFirst = (a: LinearDocument, b: LinearDocument) => Number(reservedById.has(b.id)) - Number(reservedById.has(a.id)) || a.id.localeCompare(b.id);
    for (const doc of [...work.values()].filter(live).sort(reservedFirst)) {
      const path = destination(doc, reservations, allocated);
      allocated.set(path, doc.id);
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
          removeBody(old.path);
          ids.delete(old.path);
          documentIds.delete(old.path);
          result.removed.push(old.path);
        }
        continue;
      }
      const path = paths.get(doc.id)!;
      const prior = splitFile(old === undefined ? '' : previous.get(old.path)?.toString('utf8') ?? '');
      const head = old !== undefined && path !== old.path && annotationHead(old.path) !== undefined ? relocatedHead(prior.head) : prior.head;
      try {
        const assets = await downloadAssets(path, doc.content ?? '', uploads, old === undefined ? undefined : prior.body, old?.path);
        const candidate: Candidate = {doc, path, head, assets, files: new Map<string, Buffer | string>([[path, head + assets.body], ...assets.files])};
        if (old?.path === path) candidate.previousBody = prior.body;
        candidates.set(doc.id, candidate);
        resetTarget(doc.id);
        if (old !== undefined) documentIds.delete(old.path);
        documentIds.set(path, doc.id);
      } catch (error) {
        if (error instanceof LinearStoppedError) throw error;
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
      const refusal = lengthRefusal({content: candidate.doc.content ?? ''}, linear.facts);
      if (refusal !== undefined) result.writeBackWarnings.push({path: candidate.path, code: 'linear-content-too-large-to-write-back', length: refusal.length, limit: refusal.limit});
      const old = byId.get(id);
      if (old !== undefined && old.path !== candidate.path) {
        removeBody(old.path);
        ids.delete(old.path);
        result.removed.push(old.path);
      }
      ids.set(candidate.path, old?.entry ?? {id});
      for (const [path, content] of candidate.files) {
        // A record can retain a git-only excluded file without sending it to
        // Linear. Compare against the last accepted state, not an intervening
        // record that also retained the excluded bytes.
        const prior = previous.get(path);
        if (path === candidate.path && old?.path === path && prior !== undefined && excludedPath(path)) {
          const baseline = baselines.get(path);
          if (baseline != null && splitFile(baseline.text).body === splitFile(String(content)).body) continue;
        }
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
    if (!pushed.ok) { result.ok = false; result.code = 'state-moved'; result.writeBackWarnings = []; }
    else {
      result.state = next;
      published = true;
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
    result.summary = renderCapture(result, gate.configured);
    return result;
  } catch (error) {
    // Linear stopped the client or failed a request it may answer next time: the capture keeps what it published, and the
    // next run reads again. A refusal (forbidden, invalid input) fails the run: it would come back on every run.
    if (!(error instanceof LinearStoppedError) && !(error instanceof LinearError && isTransientLinearError(error))) throw error;
    result.ok = false;
    if (error instanceof LinearStoppedError) {
      result.code = 'stopped';
      result.stopped = error.reason;
    } else {
      result.code = 'linear-failed';
      result.failure = { operation: error.operation, error: describeLinearError(error as LinearError) };
    }
    if (!published) { result.changed = []; result.removed = []; result.writeBackWarnings = []; }
    result.summary = renderCapture(result, gate.configured);
    return result;
  } finally { await gate.close?.(); }
}

/** Folder configuration remains at its original path; other metadata follows the body. */
function relocatedHead(head: string): string {
  const front = findFrontMatter(head);
  if (front === null) return head;
  const document = parseDocument(front.yaml, {logLevel:'error', prettyErrors:false});
  const metadata = document.toJS() as Record<string, unknown>;
  delete metadata[TEAM_KEY];
  delete metadata[PROJECT_KEY];
  document.delete(TEAM_KEY);
  document.delete(PROJECT_KEY);
  if (isMap(document.contents) && document.contents.items.length === 0) return '';
  let yaml: string;
  try { yaml = document.toString(); }
  catch {
    // An unrelated value may alias an annotation's deleted anchor.
    yaml = stringify(metadata);
  }
  return `---\n${yaml}---\n\n`;
}

function renderCapture(result: CaptureResult, configured: boolean): string {
  let summary = `Captured ${result.changed.length} files; removed ${result.removed.length}; blocked ${result.blocked.length}; left out ${result.leftOut.length}.`;
  if (result.stopped !== undefined) summary += `\nCapture partial, will continue.\n\n${renderStop(result.stopped).join('\n')}`;
  if (result.failure !== undefined) summary += `\nCapture partial, will continue: Linear failed ${result.failure.operation} (${result.failure.error}).`;
  if (!configured) summary += '\nContent is pushed unchecked: no security hooks are configured.';
  for (const warning of result.writeBackWarnings) {
    summary += `\n${warning.code}: ${JSON.stringify(warning.path)} (${warning.length} characters; limit ${warning.limit}). Captured into git; Linear will not accept it back if it is changed in git while still over the limit.`;
  }
  return summary;
}

/** Apply only LFS, after the security gate. Other clean filters cannot change captured text. */
export async function prepareLfs(git: RunContext['git'], tracked: Oid, changes: Map<string, Buffer | string | null>) {
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

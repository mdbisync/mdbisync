// Step one of a run: read Linear's changes, scan them, then record and push
// accepted content and its identities in one atomic transaction.
import { type FileContent, contentBytes, ContentSpool } from '../state/content.ts';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { isMap, parseDocument, stringify } from 'yaml';
import { loadMapping, readAnnotation, findFrontMatter, TEAM_KEY, PROJECT_KEY } from '../mapping/index.ts';
import { resolveTargets } from '../setup/linear.ts';
import { nearestZone, folderOf } from '../mapping/annotations.ts';
import { joinFile, lintInTree, sameMarkdown, splitFile } from '../format/index.ts';
import { type LinearDocument, type StopReason, LinearError, LinearStoppedError, describeLinearError, isTransientLinearError } from '../linear/index.ts';
import { renderStop } from '../run/stop.ts';
import { documentUrlBase, linksFromLinear, linksLinearDocuments, linksToLinear, workspaceUrlKey, type LinkSpellings } from '../initial-sync/links.ts';
import { annotatedPlaces, placeId } from '../initial-sync/plan.ts';
import { type RunContext } from '../run/preflight.ts';
import { containersOf } from '../run/capacity.ts';
import { type CommitIdentity, type IdEntry, type Git, type StateConfig, type StateSnapshot, type Oid, commitTree, commitIds, commitUploads, pushAtomic, stateRef, listTree, parseLfsPointer, readBlobs, readIds, readReservedIds, readSupersededIds, readUploads, UPLOADS_REBUILDING } from '../state/index.ts';
import { securityGate, type SecurityGate, type SecurityFinding } from './security.ts';
import { MARKS, type ConflictNotices, noConflictNotices, reconcileDocumentMark, releasedHold, type BlockedFinding } from './marks.ts';
import { readRecorded, recordedTime } from './recorded.ts';
import { detectConflicts } from '../merge/index.ts';
import { documentPath } from './paths.ts';
import { type Side, lastSynchronized } from './merge.ts';
import { lengthRefusal } from '../linear/index.ts';
import { createAssetCapture, AttachmentBudgetError, ImageBlockedError, DownloadRetryError, type CapturedAssets } from './assets.ts';
import { rebuildIds } from './rebuild.ts';
import { message } from '../messages.ts';
import { type CaptureCode, type CaptureLeftOutRule, type WriteBackWarningCode } from '../codes.ts';

export interface CaptureOptions {
  config: StateConfig;
  /** The state refs left by the previous step, used as push leases. */
  state: StateSnapshot;
  identity?: CommitIdentity;
  security?: SecurityGate;
  /**
   * The first of the staged security steps: read Linear's changes and ask
   * the gate about them, then stop. Nothing is written to git or Linear.
   */
  stageOnly?: boolean;
  fetch?: typeof fetch;
}

export interface CaptureResult {
  ok: boolean;
  code?: CaptureCode;
  /** Linear failed a request (a server error, a lost connection, an error answer): its operation and error, no content. */
  failure?: { operation: string; error: string };
  /** A resumable client budget stop; state is the last successful push. */
  stopped?: StopReason;
  /** The state refs after capture, or the input snapshot if its push lost the lease. */
  state: StateSnapshot;
  /** Metadata for every observed document; selected changes also have content. Never serialize these. */
  documents: Map<string, LinearDocument>;
  blocked: Array<{ id: string; path: string; findings: BlockedFinding[] }>;
  changed: string[];
  removed: string[];
  /**
   * Files whose documents Linear did not return while their place listed no
   * document at all: a blank answer reads the same, so they stay until a
   * later capture finds them gone again while some place lists documents.
   */
  heldRemovals: string[];
  leftOut: Array<{ id: string; rule: CaptureLeftOutRule }>;
  /** The `ids` ref was lost: how many of the recorded files got their document back by title, of how many. */
  rebuiltIds?: { matched: number; files: number };
  /** Captured content that exceeds Linear's write limit; paths and counts only. */
  writeBackWarnings: Array<{ path: string; code: WriteBackWarningCode; length: number; limit: number }>;
  summary: string;
  /**
   * The run's annotated containers as this capture listed them (trash
   * included), by `containerKey`; absent when capture listed the places of
   * a changed annotation, or listed nothing. Never serialize these.
   */
  containers?: Map<string, LinearDocument[]>;
  /** Documents whose conflict notice this capture's marks set or resolved. */
  conflictNotices: ConflictNotices;
}

const CURSOR = /^Capture-through: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)$/m;

/**
 * The trailer of an `ids` commit that sets the capture cursor: the next
 * capture reads again only the documents Linear changed at or after `through`
 * (and every document without an id).
 */
export function captureCursorTrailer(through: string): string {
  return `Capture-through: ${through}`;
}

/** A document's update time in the cursor's form, so cursor times compare as text. */
export function cursorTime(document: LinearDocument): string {
  // The same form as a recorded document's time: the capture compares the two as text.
  return recordedTime(document.updatedAt);
}
const HELD = /^Removal-held: (\S+)$/gm;

/** The ids whose removal the last capture held, from its ids commit. */
async function readHeld(context: RunContext, state: StateSnapshot): Promise<Set<string>> {
  if (state.ids === null) return new Set();
  const log = await context.git.text(['log', '--format=%B', '--grep=^Capture document ids', '-1', state.ids]);
  return new Set([...log.matchAll(HELD)].map((match) => match[1]!));
}

/** Cursor is in ids history, so ordinary id commits by later steps cannot erase it. */
export async function readCaptureCursor(git: Git, ids: Oid | null): Promise<string | null> {
  if (ids === null) return null;
  const log = await git.text(['log', '--format=%B', '--grep=^Capture-through:', '-1', ids]);
  return CURSOR.exec(log)?.[1] ?? null;
}

/** A download the comparison with a file's last accepted version does not make. */
class NotDownloaded extends Error {}

export async function capture(context: RunContext, options: CaptureOptions): Promise<CaptureResult> {
  const {git, linear, fetched} = context;
  let mapping = context.mapping;
  let targets = context.targets;
  const state = { ...options.state };
  const base = state.linear;
  if (base === null) throw new Error(message('sync.needs-initial-sync'));
  const identity = options.identity ?? context.identity;
  const ids = await readIds(git, state.ids);
  const uploads = await readUploads(git, state.uploads);
  const reserved = await readReservedIds(git, state.ids);
  // The write step relinks the documents that still name a superseded id; until then a link by it reads back as the
  // link to its path.
  const superseded = await readSupersededIds(git, state.ids);
  const gate = options.security ?? await securityGate(git, fetched.tracked);
  const result: CaptureResult = {ok:true, state, documents:new Map(), blocked:[], changed:[], removed:[], heldRemovals:[], leftOut:[], writeBackWarnings:[], summary:'', conflictNotices:noConflictNotices()};
  const spool = new ContentSpool();
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
      if (resolved.targets === undefined) throw new Error(message('sync.places-unresolved'));
      targets = resolved.targets;
    }
    if (state.ids === null) {
      // The map is lost (initial sync always records it): match the recorded files to their documents by title.
      const texts = await readBlobs(git, recorded.documents.map((document) => document.oid));
      const documents = recorded.documents.map((document) => ({ ...document, text: texts.get(document.oid)!.toString('utf8') }));
      for (const [path, entry] of await rebuildIds({ git, record: base, linear, facts: linear.facts, targets, documents, files: recorded.files, unmapped: [...recorded.leftOut, ...recorded.unsynced].map((file) => file.path) })) ids.set(path, entry);
      // Files left out for a title another file has count too: they had a document as much as any other.
      result.rebuiltIds = { matched: ids.size, files: recorded.documents.length + recorded.leftOut.length };
    }
    const cursor = await readCaptureCursor(git, state.ids);
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
      folders.set(placeKeyOf(resolved), folder);
      return resolved;
    });
    // The place a known file's document belongs in: its zone's project, or its team zone.
    const recordedPlace = (path: string): string | undefined => {
      const zone = nearestZone(mapping.zones, folderOf(path));
      if (zone === undefined) return undefined;
      const resolved = placeId(targets, zone.project === undefined ? {kind:'team', team:zone.team} : {kind:'project', team:zone.team, project:zone.project});
      return placeKeyOf(resolved);
    };
    const inPlaces = await linear.listDocumentsInPlaces(places, {includeArchived:true});
    for (const document of inPlaces) listed.set(document.id, document);
    // The write step counts its containers from this listing when it can write nothing.
    if (!changedPlace) result.containers = containersOf(context, inPlaces);
    // Looking up known ids also finds trash, project moves and moves out of scope.
    const missing = [...byId.keys()].filter((id) => !listed.has(id));
    for (const document of await linear.getDocuments(missing)) listed.set(document.id, document);
    // A known id that neither answer has: `document(id:)` tells a document Linear no longer has (removed from the
    // trash for good) from one a list left out. A document gone for good is a deletion. But Linear has answered a
    // lookup with nothing while everything existed, and a blank answer reads the same as every document removed for
    // good. So a removal counts at once only when the document's place listed documents (trash included) in this run.
    // Otherwise it is held; the next capture confirms it when it finds the id gone again while some place lists
    // documents, so a blank answer for every place holds it again however long it lasts.
    const notFound: string[] = [];
    for (const id of missing.filter((id) => !listed.has(id))) {
      const document = await linear.getDocument(id);
      if (document === null) notFound.push(id);
      else listed.set(id, document);
    }
    const answered = new Set(inPlaces.map(placeKeyOf));
    const heldBefore = await readHeld(context, state);
    const gone = new Set<string>();
    const held = new Set<string>();
    for (const id of notFound) {
      const place = recordedPlace(byId.get(id)!.path);
      if ((place !== undefined && answered.has(place)) || (heldBefore.has(id) && answered.size > 0)) gone.add(id);
      else held.add(id);
    }
    // Git-only exclusions keep their last accepted identity and place. A
    // collision or an annotation recorded for other files is not a Linear move.
    const baselines = new Map<string, Awaited<ReturnType<typeof lastSynchronized>>>();
    // Several excluded files walk the same commits of the chain: each commit is read once.
    const sides = new Map<string, Promise<Side>>();
    const excludedPath = (path: string) => {
      const mapped = recorded.documents.find((document) => document.path === path);
      const prior = previous.get(path);
      return mapped === undefined || (prior !== undefined && lintInTree(path, prior.toString('utf8'), recorded.files).length > 0)
        || lengthRefusal({title: mapped.title}, linear.facts) !== undefined;
    };
    const retained = new Map<string, string>();
    for (const [id, old] of byId) {
      if (!excludedPath(old.path)) continue;
      const baseline = await lastSynchronized(git, base, old.path, linear.facts, sides);
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
    const folderFor = (doc: LinearDocument) => folders.get(placeKeyOf(doc));
    const live = (doc: LinearDocument) => !doc.trashed && doc.archivedAt === null && (folderFor(doc) !== undefined || retained.has(doc.id));
    const normalizedTime = cursorTime;
    // A document still at the update time a run recorded it with is in the record as Linear holds it.
    const recordedTimes = await readRecorded(git, state.ids);
    const asRecorded = (doc: LinearDocument) => recordedTimes.get(doc.id) === normalizedTime(doc);
    // A marked document is read on every run, so its mark follows its text; a suspended one only when Linear
    // reports it changed (its mark follows the lane, and a long suspension costs no reads), unless security hooks
    // rejected it: its rejected edit is checked again on every run, so a fixed hook lets it in.
    const marked = (doc: LinearDocument) => {
      const entry = byId.get(doc.id)?.entry;
      return entry?.saved !== undefined && (entry.suspended === undefined || entry.saved.notice?.kind === 'blocked');
    };
    let selected = [...listed.values()].filter((doc) => !byId.has(doc.id) || marked(doc) || (!asRecorded(doc) && (cursor === null || normalizedTime(doc) >= cursor)));
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
    if (gone.size > 0 || [...listed.values()].some((doc) => {
      const old = byId.get(doc.id);
      return old !== undefined && (!live(doc) || destination(doc, occupied) !== old.path);
    })) selected = [...listed.values()];
    const documents = new Map<string, LinearDocument>(listed);
    const work = new Map<string, LinearDocument>();
    for (const doc of await linear.getDocuments(selected.filter(live).map((doc) => doc.id), { withContent: true })) { documents.set(doc.id, doc); work.set(doc.id, doc); }
    // Keep metadata for out-of-scope documents; never infer deletion from a missing page.
    for (const doc of selected) if (!live(doc)) work.set(doc.id, doc);
    result.documents = documents;
    const changes = new Map<string, FileContent | null>();
    const removeBody = (path: string): boolean => {
      const next = annotationHead(path) ?? null;
      changes.set(path, next);
      return next === null ? previous.has(path) : previous.get(path)?.equals(contentBytes(next)) !== true;
    };
    // Only files already present in the branch are link targets until their
    // candidates pass. A blocked rename continues to point at its old file.
    const documentIds = new Map([...ids].filter(([path]) => previous.has(path)).map(([path, entry]) => [path, entry.id]));
    // A reserved id names its path too: a link written to a new document that is not created yet stays relative.
    for (const [id, path] of reservedById) if (!documentIds.has(path)) documentIds.set(path, id);
    for (const id of gone) {
      const old = byId.get(id)!;
      const changedFile = removeBody(old.path);
      const retained = keptForLane(old.entry);
      if (!retained) ids.delete(old.path);
      documentIds.delete(old.path);
      if (!retained || changedFile) result.removed.push(old.path);
    }
    for (const id of held) result.heldRemovals.push(byId.get(id)!.path);
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
    const linkBase = [...work.values()].some((doc) => linksLinearDocuments(doc.content ?? '')) ? documentUrlBase(await workspaceUrlKey(linear)) : undefined;
    const downloadAssets = createAssetCapture(git, options.config, base, options.fetch ?? ((input, init) => linear.transport.fetchUpload(String(input), init)), linear.transport.reads, spool);
    type Candidate = { doc: LinearDocument; path: string; head: string; previousBody?: string; assets: CapturedAssets; files: Map<string, FileContent>; checked?: string; compared?: { body: string; same: boolean } };
    const candidates = new Map<string, Candidate>();
    const resetTarget = (id: string, targets: Map<string, string> = documentIds) => {
      for (const [path, target] of targets) if (target === id) targets.delete(path);
      const old = byId.get(id);
      if (old !== undefined && previous.has(old.path)) targets.set(old.path, id);
    };
    const recordBlocked = (doc: LinearDocument, path: string, findings: BlockedFinding[]) => {
      const old = byId.get(doc.id);
      const saved = old?.entry.saved ?? {icon: doc.icon, color: doc.color};
      ids.set(old?.path ?? path, {...old?.entry, id: doc.id, saved});
      result.blocked.push({id: doc.id, path: old?.path ?? path, findings});
      resetTarget(doc.id);
    };
    for (const doc of [...work.values()].sort((a,b) => a.id.localeCompare(b.id))) {
      const old = byId.get(doc.id);
      if (!live(doc)) {
        if (old !== undefined) {
          // A retained entry (a suspended tombstone) keeps its saved decoration: give it back only once.
          const saved = old.entry.saved;
          if (saved !== undefined && options.stageOnly !== true && (doc.icon !== saved.icon || doc.color !== saved.color)) await linear.updateDocument(doc.id, {icon: saved.icon, color: saved.color});
          const changedFile = removeBody(old.path);
          const retained = keptForLane(old.entry);
          if (!retained) ids.delete(old.path);
          documentIds.delete(old.path);
          if (!retained || changedFile) result.removed.push(old.path);
        }
        continue;
      }
      const path = paths.get(doc.id)!;
      const prior = splitFile(old === undefined ? '' : previous.get(old.path)?.toString('utf8') ?? '');
      const head = old !== undefined && path !== old.path && annotationHead(old.path) !== undefined ? relocatedHead(prior.head) : prior.head;
      try {
        const assets = await downloadAssets(path, doc.content ?? '', uploads, old === undefined ? undefined : prior.body, old?.path);
        const candidate: Candidate = {doc, path, head, assets, files: new Map<string, FileContent>([[path, joinFile(head, assets.body)], ...assets.files])};
        if (old?.path === path) candidate.previousBody = prior.body;
        candidates.set(doc.id, candidate);
        resetTarget(doc.id);
        if (old !== undefined) documentIds.delete(old.path);
        documentIds.set(path, doc.id);
      } catch (error) {
        if (error instanceof LinearError) throw error;
        if (error instanceof ImageBlockedError) {
          const security = await gate.check(new Map([[path, head + (doc.content ?? '')]]));
          if (security === null) {
            result.leftOut.push({id: doc.id, rule: 'security-unchecked'});
            resetTarget(doc.id);
          } else {
            recordBlocked(doc, path, [...error.findings, ...security]);
          }
          continue;
        }
        if (error instanceof AttachmentBudgetError) result.leftOut.push({id: doc.id, rule: 'attachment-budget'});
        else if (error instanceof DownloadRetryError) result.leftOut.push({id: doc.id, rule: 'download-retry'});
        else result.leftOut.push({id: doc.id, rule: 'capture-translation'});
      }
    }
    // A rejected target may change other documents' relative links. Recheck
    // only bodies that change as targets fall back to their accepted paths.
    // A candidate's text with its links written against these targets.
    const textOf = (candidate: Candidate, targets: ReadonlyMap<string, string>) => {
      let body = candidate.assets.body;
      if (linkBase !== undefined) {
        // A link by an id its target did not get (the document was created under another) reads back as the link
        // to that target, with the spelling the file had.
        const aliases = superseded.size === 0 ? undefined : new Map([...superseded].filter(([id, path]) => targets.has(path) && targets.get(path) !== id));
        const map = {base: linkBase, ids: new Map(targets), aliases};
        const seen: LinkSpellings = new Map();
        if (candidate.previousBody !== undefined) linksToLinear(candidate.previousBody, candidate.path, map, seen);
        body = linksFromLinear(body, candidate.path, map, seen);
      }
      // Linear's own spelling of the same document is no change: keep the file's text.
      // Compared again only when other link targets change the body.
      if (candidate.compared?.body !== body) {
        const {assets} = candidate;
        const newAssets = assets.files.size > 0 || [...assets.uploads].some(([hash, url]) => uploads.get(hash) !== url);
        candidate.compared = {body, same: candidate.previousBody !== undefined && !newAssets && sameMarkdown(candidate.previousBody, body)};
      }
      return joinFile(candidate.head, candidate.compared.same ? candidate.previousBody! : body);
    };
    let again = true;
    while (again) {
      again = false;
      for (const [id, candidate] of candidates) {
        const {doc, path, head, assets} = candidate;
        const old = byId.get(id);
        const text = textOf(candidate, documentIds);
        candidate.files.set(path, text);
        if (candidate.checked === text) continue;
        const unchanged = old?.path === path && previous.get(path)?.equals(Buffer.from(text)) === true && assets.files.size === 0 && assets.uploads.size === 0;
        let findings: SecurityFinding[] | null = [];
        if (!unchanged || old?.entry.saved !== undefined) {
          // Upload URLs also enter the cache ref. Scan the original text so
          // localization cannot hide a secret embedded in a URL or its query.
          const original = head + (doc.content ?? '');
          if (original !== text) findings = await gate.check(new Map<string, FileContent>([[path, original], ...assets.files]));
          if (findings?.length === 0) findings = await gate.check(candidate.files);
        }
        if (findings === null) {
          // The hooks have not seen this text (the hooks step did not run,
          // or the tracked branch moved after it): it stays out of this run,
          // and the cursor holds, so the next run checks it.
          result.leftOut.push({id, rule: 'security-unchecked'});
          candidates.delete(id);
          resetTarget(id);
          again = true;
          break;
        }
        if (findings.length > 0) {
          recordBlocked(doc, path, findings);
          candidates.delete(id);
          again = true;
          break;
        }
        candidate.checked = text;
      }
    }
    // The stage step stops here: the reads it kept end, and the rest of the run reads Linear itself.
    linear.transport.reads?.end();
    if (options.stageOnly === true) {
      // The staging gate passed every candidate. The apply step rejects some,
      // and the documents that link to them are written with the rejected
      // targets' fallback links: stage those texts too, or they would wait
      // for an answer on every run while the target stays rejected.
      if (linkBase !== undefined) for (const set of linkVariants(candidates, textOf, resetTarget, documentIds)) await gate.check(set);
      result.summary = `Staged ${candidates.size} changed documents for the security hooks.`;
      return result;
    }
    // The apply step's documents are the stage step's snapshot, and a mark
    // saves and restores a document's icon and color. The documents whose
    // mark may change are read again: a blocked one is marked over its
    // current decoration, and any other that changed since then keeps its
    // mark until the next run captures it.
    const unmarked = new Set<string>();
    if (linear.transport.reads?.mode === 'replay') {
      const marking = [
        ...result.blocked.map(({id}) => id),
        ...[...candidates].filter(([id, {doc}]) => byId.get(id)?.entry.saved !== undefined || detectConflicts(doc.content ?? '').length > 0).map(([id]) => id),
      ];
      const current = marking.length === 0 ? new Map<string, LinearDocument>() : new Map((await linear.getDocuments(marking, {withContent: true})).map((doc) => [doc.id, doc]));
      for (const blocked of result.blocked) {
        const now = current.get(blocked.id);
        const then = documents.get(blocked.id);
        if (now === undefined || then === undefined || now.updatedAt === then.updatedAt) continue;
        documents.set(blocked.id, {...now, content: then.content ?? null});
        const entry = ids.get(blocked.path);
        if (entry !== undefined && byId.get(blocked.id)?.entry.saved === undefined) ids.set(blocked.path, {...entry, saved: {icon: now.icon, color: now.color}});
      }
      for (const [id, {doc}] of candidates) if (marking.includes(id) && current.get(id)?.updatedAt !== doc.updatedAt) unmarked.add(id);
    }
    // An excluded file's document that Linear still holds as last accepted has nothing to capture, the images it
    // downloaded included: they are read in the commit of that version, since git may have removed one since (the
    // reason the file is excluded). A run whose capture cursor is lost reads every document again.
    const acceptedAssets = new Map<Oid, ReturnType<typeof createAssetCapture>>();
    const asLastAccepted = async (candidate: Candidate): Promise<boolean> => {
      const baseline = excludedPath(candidate.path) ? baselines.get(candidate.path) : undefined;
      if (baseline == null || candidate.assets.files.size === 0) return false;
      const captureAtBaseline = acceptedAssets.get(baseline.commit) ?? createAssetCapture(git, options.config, baseline.commit, () => Promise.reject(new NotDownloaded()));
      acceptedAssets.set(baseline.commit, captureAtBaseline);
      const {head, body} = splitFile(baseline.text);
      let assets: CapturedAssets;
      try {
        assets = await captureAtBaseline(candidate.path, candidate.doc.content ?? '', uploads, body);
      } catch (error) {
        // An image that version did not have: the document changed.
        if (error instanceof DownloadRetryError && error.cause instanceof NotDownloaded) return false;
        throw error;
      }
      // Linear's spelling of that version reads back as its text.
      return assets.files.size === 0 && textOf({doc: candidate.doc, path: candidate.path, head, assets, files: new Map(), previousBody: body}, documentIds) === baseline.text;
    };
    for (const [id, candidate] of candidates) {
      const old = byId.get(id);
      if (old?.path === candidate.path && await asLastAccepted(candidate)) continue;
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
        if (previous.get(path)?.equals(contentBytes(content)) !== true) {
          changes.set(path, content);
          result.changed.push(path);
        }
      }
      for (const [hash,url] of candidate.assets.uploads) uploads.set(hash,url);
    }
    // Advance only to timestamps actually observed; equality is reread next run
    // so documents sharing a timestamp or edited during pagination are not lost.
    // A place that listed nothing may have left out changes too: the cursor holds while a removal is held.
    const through = result.leftOut.length > 0 || held.size > 0 ? cursor : [...listed.values()].map(normalizedTime).sort().at(-1) ?? cursor;
    const trailers = [...(through === null ? [] : [captureCursorTrailer(through)]), ...[...held].sort().map((id) => `Removal-held: ${id}`)];
    const commitMessage = trailers.length === 0 ? 'Capture document ids' : `Capture document ids\n\n${trailers.join('\n')}`;
    // Without the cache (lost, or never recorded yet), the write step uploads every linked file again; this mark tells it.
    const uploadsCommit = await commitUploads(git, state.uploads, uploads, identity, state.uploads === null ? { message: UPLOADS_REBUILDING, always: true } : {});
    const prepared = await prepareLfs(git, fetched.tracked, changes);
    const linearCommit = await commitTree(git, { parents: [base], base, changes: prepared.changes, message: 'Capture Linear changes', identity });
    // Record a held removal, and a cleared one, so the next capture reads what this one held.
    // The cursor alone moves no ref: an edit that changes nothing in git (an icon, a color,
    // a comment) leaves every ref where it was, and the next capture reads those documents
    // again. The cursor moves with the next capture that records a change; until then it
    // only holds back, which rereads more and loses nothing.
    const recordsChange = linearCommit !== base || uploadsCommit !== state.uploads;
    const always = held.size > 0 || heldBefore.size > 0 || (through !== cursor && recordsChange);
    const idsCommit = await commitIds(git, state.ids, ids, identity, { message: commitMessage, always, reserved, superseded });
    // Upload accepted LFS objects before publishing pointers; no blocked bytes reach this step.
    if (prepared.oids.length > 0) await git.run(['lfs', 'push', '--object-id', options.config.remote, ...prepared.oids]);
    const next = { linear: linearCommit, ids: idsCommit, uploads: uploadsCommit };
    const pushed = await pushAtomic(git, options.config, (['linear', 'ids', 'uploads'] as const).map((store) => ({ ref: stateRef(options.config, store), expected: state[store], next: next[store] })));
    if (!pushed.ok) { result.ok = false; result.code = 'state-moved'; }
    else {
      result.state = next;
      published = true;
      for (const candidate of candidates.values()) {
        const refusal = lengthRefusal({content: candidate.doc.content ?? ''}, linear.facts);
        if (refusal !== undefined) result.writeBackWarnings.push({path: candidate.path, code: 'linear-content-too-large-to-write-back', length: refusal.length, limit: refusal.limit});
      }
      const lostLease = new Error(message('sync.lost-lease'));
      const marked = [
        ...[...candidates.values()].filter(({doc}) => !unmarked.has(doc.id)).map(({doc, path}) => ({doc, path, blocked: [] as BlockedFinding[]})),
        ...result.blocked.map(({id, path, findings}) => ({doc: documents.get(id)!, path, blocked: findings})),
      ];
      try {
        for (const {doc, path, blocked} of marked) {
          const before = ids.get(path)!;
          const outcome = await reconcileDocumentMark({document: doc, entry: before, linear, blocked,
            onConflictNotice: (change) => result.conflictNotices[change].push(path),
            persistEntry: async (entry) => {
              ids.set(path, entry);
              const tip = await commitIds(git, result.state.ids, ids, identity, {reserved, superseded, message:'Capture document marks'});
              const updated = {...next, ids:tip};
              const saved = await pushAtomic(git, options.config, (['linear', 'ids', 'uploads'] as const).map((store) => ({ref:stateRef(options.config, store), expected:result.state[store], next:updated[store]})));
              if (!saved.ok) { result.ok = false; result.code = 'state-moved'; throw lostLease; }
              result.state = updated;
            },
          });
          // Later steps read decorations from this map (the suspended mark saves the document's own): keep it current.
          if (outcome.updated) {
            const mark = outcome.state === 'clear' ? before.saved : MARKS[outcome.state];
            const listed = documents.get(doc.id);
            if (mark !== undefined && listed !== undefined) documents.set(doc.id, {...listed, icon: mark.icon, color: mark.color});
          }
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
    if (!published) { result.changed = []; result.removed = []; result.heldRemovals = []; }
    result.summary = renderCapture(result, gate.configured);
    return result;
  } finally { spool.close(); await gate.close?.(); }
}

/**
 * An entry of a removed document that stays: a suspended tombstone, a release not yet recorded, or a released
 * episode's comment the hold step has not resolved yet.
 */
function keptForLane(entry: IdEntry): boolean {
  return entry.suspended !== undefined || entry.releaseBase !== undefined || releasedHold(entry);
}

/** Up to this many changed link targets, every combination of them rejected is staged; above it, each alone and all together. */
const LINK_VARIANT_TARGETS = 4;

/**
 * The sets of files each candidate would be checked with when some of the
 * other candidates it links to are rejected: its text with those targets'
 * fallback links, and its embedded files.
 */
function linkVariants<C extends { path: string; files: Map<string, FileContent> }>(
  candidates: ReadonlyMap<string, C>,
  textOf: (candidate: C, targets: ReadonlyMap<string, string>) => string,
  reset: (id: string, targets: Map<string, string>) => void,
  documentIds: ReadonlyMap<string, string>,
): Array<Map<string, FileContent>> {
  const variants: Array<Map<string, FileContent>> = [];
  const without = (rejected: readonly string[]) => {
    const targets = new Map(documentIds);
    for (const id of rejected) reset(id, targets);
    return targets;
  };
  for (const [id, candidate] of candidates) {
    const accepted = candidate.files.get(candidate.path);
    const linked = [...candidates.keys()].filter((other) => other !== id && textOf(candidate, without([other])) !== accepted);
    const combinations = linked.length <= LINK_VARIANT_TARGETS
      ? Array.from({length: 2 ** linked.length - 1}, (_, mask) => linked.filter((_, bit) => ((mask + 1) >> bit) & 1))
      : [...linked.map((other) => [other]), linked];
    const texts = new Set(combinations.map((rejected) => textOf(candidate, without(rejected))));
    texts.delete(accepted as string);
    for (const text of texts) variants.push(new Map([...candidate.files, [candidate.path, text]]));
  }
  return variants;
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

/** The key of a document's place, or of a resolved place: its project, or its team zone. */
function placeKeyOf(place: {projectId?: string | null; teamId?: string | null}): string {
  return place.projectId != null ? `project:${place.projectId}` : `team:${place.teamId}`;
}

function renderCapture(result: CaptureResult, configured: boolean): string {
  let summary = `Captured ${result.changed.length} files; removed ${result.removed.length}; blocked ${result.blocked.length}; left out ${result.leftOut.length}.`;
  for (const item of result.leftOut) if (item.rule === 'attachment-budget') summary += `\nattachment-budget: ${JSON.stringify(item.id)}. Attachment count or bytes exceeded the document or run limit; reduce attachments and retry. The cursor is held.`;
  for (const item of result.leftOut) if (item.rule === 'download-retry') summary += `\ndownload-retry: ${JSON.stringify(item.id)}. An upload could not be downloaded; the next run will retry.`;
  if (result.heldRemovals.length > 0) {
    summary += `\nRemoval held for ${result.heldRemovals.length} files: Linear did not return their documents while their place listed no document, as a blank answer would read. The files stay; the next run removes them if Linear still does not have them: ${result.heldRemovals.map((path) => JSON.stringify(path)).join(', ')}.`;
  }
  if (result.rebuiltIds !== undefined) {
    summary += `\nThe document id map was lost: rebuilt by matching titles to paths, ${result.rebuiltIds.matched} of ${result.rebuiltIds.files} files matched. A document renamed in Linear since the last run comes back as a new file next to its old one.`;
  }
  if (result.stopped !== undefined) summary += `\nCapture partial, will continue.\n\n${renderStop(result.stopped).join('\n')}`;
  if (result.failure !== undefined) summary += `\nCapture partial, will continue: Linear failed ${result.failure.operation} (${result.failure.error}).`;
  if (!configured) summary += '\nContent is pushed unchecked: no security hooks are configured.';
  for (const warning of result.writeBackWarnings) {
    summary += `\n${warning.code}: ${JSON.stringify(warning.path)} (${warning.length} characters; limit ${warning.limit}). Preserved in git; Linear will not accept it back if it is changed in git while still over the limit.`;
  }
  return summary;
}

/** Apply only LFS, after the security gate. Other clean filters cannot change captured text. */
export async function prepareLfs(git: RunContext['git'], tracked: Oid, changes: Map<string, FileContent | null>) {
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
      // No path: git-lfs takes the size of a file at that path in the working copy for the size of
      // its input, and a checkout without LFS content holds the pointer there, so it would store only
      // the first kilobyte of the content. The content given here is never the file on disk.
      const bytes = contentBytes(content);
      const cleaned = await git.run(['lfs', 'clean'], { input: bytes });
      const pointer = parseLfsPointer(cleaned.stdout);
      // Content that already is a pointer, or is empty, comes back as it is; any other becomes a pointer to the whole content.
      if (!cleaned.stdout.equals(bytes)) {
        if (pointer === null) throw new Error(message('sync.no-lfs-pointer'));
        if (pointer.size !== bytes.length || pointer.oid !== createHash('sha256').update(bytes).digest('hex')) throw new Error(message('sync.lfs-pointer-mismatch'));
      }
      if (pointer !== null) oids.push(pointer.oid);
      result.set(path, cleaned.stdout);
    }
    return { changes: result, oids: [...new Set(oids)] };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

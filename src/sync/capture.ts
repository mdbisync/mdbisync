// Step one of a run: read Linear's changes, scan them, then record and push
// accepted content and its identities in one atomic transaction.
import { type FileContent, contentBytes, ContentSpool } from '../state/content.ts';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { isMap, parseDocument, stringify } from 'yaml';
import { isMarkdownPath, placeOf, readAnnotation, findFrontMatter, TEAM_KEY, PROJECT_KEY } from '../mapping/index.ts';
import { checkMappingBudget, mapTree } from '../mapping/mapping.ts';
import { pendingProject, resolveTargets } from '../setup/linear.ts';
import { nearestZone, folderOf } from '../mapping/annotations.ts';
import { MAPPING_FILE_BYTES, MAPPING_TREE_BYTES, MappingBlobBudget, readableBlob } from '../mapping/blobs.ts';
import { fixLinearText, joinFile, linkedFileCheck, lintRecorded, sameAsLinear, splitFile } from '../format/index.ts';
import { type LinearDocument, type StopReason, LinearError, LinearStoppedError, describeLinearError, isTransientLinearError } from '../linear/index.ts';
import { renderStop } from '../run/stop.ts';
import { documentUrlBase, hasDocumentLinks, linksFromLinear, linksLinearDocuments, linksToLinear, workspaceUrlKey, type LinkSpellings } from '../initial-sync/links.ts';
import { MarkdownLimitError, linearMarkersAsText, markdownBaseline } from '../format/markdown.ts';
import { annotatedPlaces, placeId } from '../initial-sync/plan.ts';
import { checkFileTargets, FileTargetsAddedError } from '../initial-sync/uploads.ts';
import { type RunContext } from '../run/preflight.ts';
import { containersOf } from '../run/capacity.ts';
import { lineText } from '../run/output.ts';
import { type CommitIdentity, type IdEntry, type Git, GitLfsMissingError, lfsPush, lfsRemote, type StateConfig, type StateSnapshot, type Oid, commitTree, commitIds, commitUploads, pushAtomic, stateRef, listTree, parseLfsPointer, readIds, readReservedIds, readSupersededIds, readUploads, signIdsTrailers, signObservation, UPLOADS_REBUILDING } from '../state/index.ts';
import { checkTitle, securityGate, type SecurityGate, type SecurityFinding } from './security.ts';
import { MARKS, type ConflictNotices, markWritesLinear, noConflictNotices, reconcileDocumentMark, releasedHold, type BlockedFinding } from './marks.ts';
import { captureCursorTrailer, matchesObservedBody, observedDigest, readCaptureCheckpoints, recordedTime, recordedTrailers } from './recorded.ts';
import { detectConflicts } from '../merge/index.ts';
import { documentPath, isUntitled, keptPath } from './paths.ts';
import { type Side, lastSynchronized } from './merge.ts';
import { lengthRefusal } from '../linear/index.ts';
import { createAssetCapture, uploadAccessProbe, AttachmentBudgetError, ImageBlockedError, DownloadRetryError, type CapturedAssets, withNewUploadUrls } from './assets.ts';
import { readPlainFileProvenance, repairSet, signRepair, signedRepair } from './pull-repairs.ts';
import { checkImageRepairSize, imageLinks, ImageRepairBudgetError } from './image-links.ts';
import { rebuildIds } from './rebuild.ts';
import { pendingMove, syncedPlaces } from './tracked-places.ts';
import { message } from '../messages.ts';
import { type CaptureCode, type CaptureLeftOutRule, type WriteBackWarningCode } from '../codes.ts';
import { VERSION, olderVersion } from '../version.ts';
import { listPaths } from '../state/objects.ts';

/** The subject of a capture commit on the `linear` ref: Linear members' text entering git. */
export const CAPTURE_MESSAGE = 'Capture Linear changes';

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
  /**
   * Metadata for every observed document Linear places in a configured place (trash and archive included);
   * selected changes also have content. A known id read outside them is left out: the ids state alone does not
   * let a later step mark or restore it. Never serialize these.
   */
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
  /**
   * Suspended documents this capture read again for its version (see `readByOtherVersion`) whose reading is what the
   * tracked branch holds, by path: also those whose recorded reading already was, so their record does not change.
   */
  rereadAsTracked?: string[];
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
  const uploads = await readUploads(git, state.uploads, context.pushedKey);
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
    const blobBudget = new MappingBlobBudget();
    const entries = await listTree(git, base, MAPPING_TREE_BYTES);
    const recorded = await mapTree(git, entries, blobBudget);
    // An already synchronized project that disappeared may have been renamed or made inaccessible.
    // Treating its folder as newly empty would capture removals of its documents.
    for (const zone of recorded.zones.values()) {
      const place = placeOf(zone);
      if (place.kind === 'project' && pendingProject(targets, place)) {
        throw new Error(message('sync.recorded-project-missing', { project: lineText(place.project), team: lineText(place.team) }));
      }
    }
    const zones = new Map(mapping.zones);
    let changedPlace = false;
    for (const [folder, old] of recorded.zones) {
      const current = zones.get(folder);
      if (current !== undefined && (old.team !== current.team || old.project !== current.project)) {
        // An old place is read only to finish the tracked branch's latest move of the folder, never a place it held before.
        if (!await pendingMove(git, fetched.tracked, folder, placeOf(old), placeOf(current))) throw new Error(message('sync.recorded-place-unknown', {folder: folder === '' ? 'the repository root' : `${folder}/`}));
        zones.set(folder, old);
        changedPlace = true;
      }
    }
    if (changedPlace) {
      mapping = {...mapping, zones};
      const current = targets;
      const resolved = await resolveTargets(linear, [...zones.values()].filter((zone) => !pendingProject(current, placeOf(zone))));
      if (resolved.targets === undefined) throw new Error(message('sync.places-unresolved'));
      targets = { ...resolved.targets, ...(current.pendingProjects === undefined ? {} : { pendingProjects: current.pendingProjects }) };
    }
    // The recorded state comes from refs any writer can move: a file's place only it names is read when the tracked
    // branch held the file synchronized there.
    const allowedPlace = syncedPlaces(git, fetched.tracked, context.mapping.zones, zones, linear.facts);
    if (state.ids === null) {
      // The map is lost (initial sync always records it): match the recorded files to their documents by title.
      const paths = new Set(recorded.documents.map((document) => document.path));
      const texts = await blobBudget.read(git, entries.filter((entry) => paths.has(entry.path)));
      const documents = recorded.documents.map((document) => ({ ...document, text: texts.get(document.oid)!.toString('utf8') }));
      const plainProvenance = await readPlainFileProvenance(git, base);
      for (const [path, entry] of await rebuildIds({ git, record: base, linear, facts: linear.facts, targets, allowedPlace, documents, files: recorded.files, unmapped: [...recorded.leftOut, ...recorded.unsynced].map((file) => file.path) })) {
        const plainFiles = plainProvenance.get(entry.id);
        ids.set(path, plainFiles === undefined ? entry : {...entry, plainFiles: [...plainFiles]});
      }
      // Files left out for a title another file has count too: they had a document as much as any other.
      result.rebuiltIds = { matched: ids.size, files: recorded.documents.length + recorded.leftOut.length };
    }
    const {cursor, recorded: recordedTimes, needsCursor} = await readCaptureCheckpoints(git, state.ids, base, context.pushedKey);
    const recordedBlobs = entries.filter((entry) => entry.type === 'blob' && ids.has(entry.path));
    const textEntries = recordedBlobs.filter(readableBlob);
    const unreadIds = new Set(recordedBlobs.filter((entry) => !readableBlob(entry)).map((entry) => ids.get(entry.path)!.id));
    for (const id of unreadIds) result.leftOut.push({id, rule: 'blob-too-large'});
    const blobs = await blobBudget.read(git, textEntries);
    const previous = new Map(textEntries.map((entry) => [entry.path, blobs.get(entry.oid)!]));
    const byId = new Map([...ids].map(([path, entry]) => [entry.id, { path, entry }]));
    // A new document's id is reserved for its path until it is mapped. Documents an earlier run wrote may link to it, and
    // its create may have landed with the answer lost: the reserved path is where it belongs.
    // The reserved ids come from refs any writer can move, so a reserved path is only a claim: it counts only for a
    // Markdown file the tracked branch holds, the file the new document was created from, never a script beside it.
    const reservedById = new Map([...reserved].filter(([path, id]) => !ids.has(path) && !byId.has(id) && isMarkdownPath(path) && mapping.files.has(path)).map(([path, id]) => [id, path]));
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
    const places = annotatedPlaces(mapping.zones).filter(({place}) => !pendingProject(targets, place)).map(({place, folder}) => {
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
      if (unreadIds.has(id)) continue;
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
      return mapped === undefined || (prior !== undefined && lintRecorded(path, prior.toString('utf8'), recorded.files).length > 0)
        || lengthRefusal({title: mapped.title}, linear.facts) !== undefined;
    };
    const retained = new Map<string, string>();
    // The place each retained document was listed in: it is the sync's only there.
    const retainedPlace = new Map<string, string>();
    for (const [id, old] of byId) {
      if (unreadIds.has(id) || !excludedPath(old.path)) continue;
      const baseline = await lastSynchronized(git, base, old.path, linear.facts, sides);
      baselines.set(old.path, baseline);
      const doc = listed.get(id);
      if (baseline === null || doc === undefined || doc.title.normalize('NFC') !== baseline.file.title.normalize('NFC')) continue;
      if (!await allowedPlace(old.path, baseline.file.place)) continue;
      let resolved;
      try { resolved = placeId(targets, baseline.file.place); }
      catch {
        const place = baseline.file.place;
        const lookup = await resolveTargets(linear, [{team:place.team, teamFolder:'', ...(place.kind === 'project' ? {project:place.project, projectFolder:''} : {})}]);
        if (lookup.targets === undefined) continue;
        resolved = placeId(lookup.targets, place);
      }
      if ('projectId' in resolved ? resolved.projectId === doc.projectId : doc.projectId === null && resolved.teamId === doc.teamId) {
        retained.set(id, old.path);
        retainedPlace.set(id, placeKeyOf(doc));
      }
    }
    const folderFor = (doc: LinearDocument) => folders.get(placeKeyOf(doc));
    // Linear's own answer for where a document is, never the ids state, decides whether the sync may change it: a
    // known id is only a path's claim, and anyone who can push the state refs can make that claim.
    const placed = (doc: LinearDocument) => folderFor(doc) !== undefined || (retained.has(doc.id) && retainedPlace.get(doc.id) === placeKeyOf(doc));
    const live = (doc: LinearDocument) => !doc.trashed && doc.archivedAt === null && placed(doc);
    const normalizedTime = cursorTime;
    // A document still at the update time a run recorded it with is in the record as Linear holds it.
    const asRecorded = (doc: LinearDocument) => recordedTimes.get(doc.id) === normalizedTime(doc);
    // A marked document is read on every run, so its mark follows its text; a suspended one only when Linear
    // reports it changed (its mark follows the lane, and a long suspension costs no reads), unless security hooks
    // rejected it: its rejected edit is checked again on every run, so a fixed hook lets it in.
    const marked = (doc: LinearDocument) => {
      const entry = byId.get(doc.id)?.entry;
      return entry?.saved !== undefined && (entry.suspended === undefined || entry.saved.notice?.kind === 'blocked');
    };
    // Older ids entries have no digest. Read those bodies once so a later write can still verify them if the
    // attachment cache is unavailable.
    // A stored repair the sync did not sign (one recorded before repairs were signed, or written into the ref) is
    // never applied: its document is read again, so its repair is recorded anew, signed, or dropped.
    const unsignedRepair = (old: {path: string; entry: IdEntry}) => old.entry.pullRewrite !== undefined && signedRepair(context.pushedKey, old.path, old.entry) === undefined;
    // A suspended document whose recorded text another version read is read again, though Linear reports no change:
    // a newer reading can show the document is what git holds, and its lane can then let it go.
    const readByOtherVersion = (old: {path: string; entry: IdEntry}) => old.entry.suspended !== undefined && olderVersion(old.entry.capturedWith, VERSION);
    let selected = [...listed.values()].filter((doc) => {
      const old = byId.get(doc.id);
      return old === undefined || marked(doc) || (old.entry.observedDigest === undefined && live(doc) && previous.has(old.path) && !excludedPath(old.path))
        || (unsignedRepair(old) && live(doc) && previous.has(old.path))
        || (readByOtherVersion(old) && live(doc) && previous.has(old.path))
        || (!asRecorded(doc) && (cursor === null || normalizedTime(doc) >= cursor));
    });
    const invalidZone = (doc: LinearDocument, path: string) => {
      const zone = nearestZone(mapping.zones, folderOf(path));
      if (zone === undefined) return true;
      const place = zone.project === undefined ? {kind: 'team' as const, team: zone.team} : {kind: 'project' as const, team: zone.team, project: zone.project};
      const target = placeId(targets, place);
      return 'projectId' in target ? target.projectId !== doc.projectId : doc.projectId !== null || target.teamId !== doc.teamId;
    };
    const destination = (doc: LinearDocument, occupied: ReadonlySet<string>, allocated: ReadonlyMap<string, string> = new Map()) => {
      if (retained.has(doc.id)) return retained.get(doc.id)!;
      const folder = folderFor(doc)!;
      const invalid = (path: string) => invalidZone(doc, path);
      // An empty title names no file: a document whose title was cleared keeps the file it has, where it still can.
      const untitled = isUntitled(doc.title);
      const own = reservedById.get(doc.id);
      // And only where the sync would put this document itself: its title's own spelling, with no alias of a taken path.
      if (own !== undefined && !occupied.has(own) && !allocated.has(own) && !invalidZone(doc, own)
        && (untitled ? keptPath(folder, occupied, own, invalid) : documentPath(folder, doc.title, doc.id, occupied, own, invalid)) === own) return own;
      const old = byId.get(doc.id);
      const available = new Set(occupied);
      if (old !== undefined && (!allocated.has(old.path) || allocated.get(old.path) === doc.id)) available.delete(old.path);
      // Keep Git-authored paths: moving a tracked `.github` file could disable a template.
      // An unsafe spelling only in earlier capture state must use the encoded title instead.
      const prior = old !== undefined && !mapping.files.has(old.path) && old.path.split('/').some((part) => part.toLowerCase() === '.github') ? undefined : old?.path;
      // Only a file the record holds: an `ids` path alone is a claim, not a file.
      const kept = untitled && prior !== undefined && isMarkdownPath(prior) && previous.has(prior) ? keptPath(folder, available, prior, invalid) : undefined;
      return kept ?? documentPath(folder, doc.title, doc.id, available, prior, invalid);
    };
    // An unchanged source may link a renamed, moved or removed target. When a path changes, the documents that move
    // are read again, and so are those whose recorded file links one of the paths that move or go, so their links
    // are translated too. Any other document keeps its file as it is: reading every body would show the hooks the
    // whole workspace again for one rename.
    const leaving = new Map<string, string>();
    for (const id of gone) leaving.set(byId.get(id)!.path, id);
    const moving = [...listed.values()].filter((doc) => {
      const old = byId.get(doc.id);
      return old !== undefined && !unreadIds.has(doc.id) && (!live(doc) || destination(doc, occupied) !== old.path);
    });
    for (const doc of moving) leaving.set(byId.get(doc.id)!.path, doc.id);
    // Earlier runs wrote links to a new document's reserved path too: they move when it does not end up there.
    for (const [id, own] of reservedById) {
      const doc = listed.get(id);
      if (doc !== undefined && (!live(doc) || destination(doc, occupied) !== own)) leaving.set(own, id);
    }
    // Whether a recorded file's body links one of `paths`, as the translation reads it. A body past the Markdown
    // limits, and a file that holds Git's excluded version instead of the document's own text, count as linking.
    const linksTo = (paths: ReadonlyMap<string, string>, old: {path: string}) => {
      const prior = previous.get(old.path);
      if (prior === undefined) return false;
      if (excludedPath(old.path)) return true;
      try { return hasDocumentLinks(splitFile(prior.toString('utf8')).body, old.path, paths); }
      catch (error) {
        if (error instanceof MarkdownLimitError) return true;
        throw error;
      }
    };
    if (leaving.size > 0) {
      const chosen = new Set([...selected, ...moving]);
      for (const doc of listed.values()) {
        const old = byId.get(doc.id);
        if (!chosen.has(doc) && old !== undefined && linksTo(leaving, old)) chosen.add(doc);
      }
      selected = [...chosen];
    }
    selected = selected.filter((doc) => !unreadIds.has(doc.id));
    const documents = new Map<string, LinearDocument>([...listed].filter(([, doc]) => placed(doc)));
    const work = new Map<string, LinearDocument>();
    let missingBodies = false;
    const readBodies = async (requested: readonly LinearDocument[]) => {
      const read = await linear.getDocuments(requested.map((doc) => doc.id), { withContent: true });
      const answered = new Set<string>();
      for (const doc of read) {
        if (live(doc) && doc.content === undefined) continue;
        // A document moved out of the places between the listing and this read is not taken into the map.
        if (placed(doc)) documents.set(doc.id, doc);
        else documents.delete(doc.id);
        work.set(doc.id, doc);
        answered.add(doc.id);
      }
      if (requested.some(({id}) => !answered.has(id))) missingBodies = true;
    };
    await readBodies(selected.filter(live));
    // A document renamed or moved after the listing moves by this read: the files linking its old path are read too.
    const late = new Map<string, string>();
    for (const doc of work.values()) {
      const old = byId.get(doc.id);
      if (old !== undefined && !leaving.has(old.path) && (!live(doc) || destination(doc, occupied) !== old.path)) late.set(old.path, doc.id);
    }
    if (late.size > 0) {
      const linking = [...listed.values()].filter((doc) => {
        const old = byId.get(doc.id);
        return !work.has(doc.id) && !unreadIds.has(doc.id) && live(doc) && old !== undefined && linksTo(late, old);
      });
      await readBodies(linking);
    }
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
    const documentIds = new Map([...ids].filter(([path, entry]) => previous.has(path) || unreadIds.has(entry.id)).map(([path, entry]) => [path, entry.id]));
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
    const limited = new Set<string>();
    let needsLinkBase = false;
    // Each document's text as Linear holds it, with the file's body before this run (where it has one).
    // Links and files are found in that text: a marker escape Linear dropped (`4)     [a](b)`)
    // would otherwise read as a list item holding code, which hides the link.
    const readable = new Map<string, {text: string; previousBody: string | undefined}>();
    // Such a document is compared with the tracked branch's text: the recorded one is the older reading itself.
    const reread = new Set([...work.values()].filter((doc) => {
      const old = byId.get(doc.id);
      return old !== undefined && live(doc) && readByOtherVersion(old);
    }).map((doc) => doc.id));
    const rereadPaths = [...reread].map((id) => byId.get(id)!.path);
    const trackedBodies = new Map<string, string>();
    if (rereadPaths.length > 0) {
      const tracked = (await listPaths(git, fetched.tracked, rereadPaths)).filter((entry) => entry.type === 'blob' && readableBlob(entry));
      // A tracked file the record holds as it is is read already; the others have a budget of their own, so the
      // record's own reads keep theirs.
      const recordedOids = new Map(textEntries.map((entry) => [entry.path, entry.oid]));
      const unread = tracked.filter((entry) => recordedOids.get(entry.path) !== entry.oid);
      const blobs = await new MappingBlobBudget().read(git, unread);
      for (const entry of tracked) {
        const bytes = recordedOids.get(entry.path) === entry.oid ? previous.get(entry.path)! : blobs.get(entry.oid)!;
        trackedBodies.set(entry.path, splitFile(bytes.toString('utf8')).body);
      }
    }
    /** Whether a reading of a document read again is what the tracked branch holds there. */
    const readsAsTracked = (path: string, text: string) => trackedBodies.has(path) && trackedBodies.get(path)!.replace(/\n+$/, '') === splitFile(text).body.replace(/\n+$/, '');
    for (const doc of work.values()) {
      if (!live(doc)) continue;
      try {
        // Check every body, including those after the first linked document.
        checkImageRepairSize(doc.content ?? '');
        const old = byId.get(doc.id);
        // An over-limit legacy body is not evidence for links or equality.
        // A document read again has the tracked branch's text as its baseline, or none: never its older reading.
        const recordedBody = old === undefined ? undefined : reread.has(doc.id) ? trackedBodies.get(old.path) : splitFile(previous.get(old.path)?.toString('utf8') ?? '').body;
        const previousBody = recordedBody === undefined ? undefined : markdownBaseline(recordedBody);
        const text = linearMarkersAsText(doc.content ?? '', previousBody);
        readable.set(doc.id, {text, previousBody});
        if (linksLinearDocuments(text)) needsLinkBase = true;
      } catch (error) {
        if (!(error instanceof MarkdownLimitError || error instanceof ImageRepairBudgetError)) throw error;
        limited.add(doc.id);
        result.leftOut.push({id: doc.id, rule: error instanceof ImageRepairBudgetError ? 'image-repair-budget' : 'markdown-complexity'});
      }
    }
    const linkBase = needsLinkBase ? documentUrlBase(await workspaceUrlKey(linear)) : undefined;
    const downloadAssets = createAssetCapture(git, options.config, base, options.fetch ?? ((input, init) => linear.transport.fetchUpload(String(input), init)), linear.transport.reads, spool, undefined, uploadAccessProbe(linear));
    type Candidate = { doc: LinearDocument; path: string; head: string; previousBody?: string; assets: CapturedAssets; files: Map<string, FileContent>; checked?: string; observed?: string; compared?: { body: string; text: string; addsFiles: boolean } };
    const candidates = new Map<string, Candidate>();
    // A rejected target links to its accepted file, if it has one.
    const resetTargets = (rejected: ReadonlySet<string>, targets: Map<string, string>) => {
      for (const [path, target] of targets) if (rejected.has(target)) targets.delete(path);
      for (const id of rejected) {
        const old = byId.get(id);
        if (old !== undefined && previous.has(old.path)) targets.set(old.path, id);
      }
    };
    const resetTarget = (id: string, targets: Map<string, string> = documentIds) => resetTargets(new Set([id]), targets);
    // Keyed by the document's recorded path by default.
    const recordBlocked = (doc: LinearDocument, path: string, findings: BlockedFinding[], key = byId.get(doc.id)?.path ?? path) => {
      const old = byId.get(doc.id);
      const saved = old?.entry.saved ?? {icon: doc.icon, color: doc.color};
      ids.set(key, {...old?.entry, id: doc.id, saved});
      result.blocked.push({id: doc.id, path: key, findings});
      resetTarget(doc.id);
    };
    const restores: Array<{doc: LinearDocument; saved: {icon: string | null; color: string | null}; path: string; entry: IdEntry}> = [];
    for (const doc of [...work.values()].sort((a,b) => a.id.localeCompare(b.id))) {
      const old = byId.get(doc.id);
      if (!live(doc)) {
        if (old !== undefined) {
          // A retained entry (a suspended tombstone) keeps its saved decoration: give it back only once, and only to a
          // document in the trash or archive of a configured place. One outside them is not the sync's to decorate.
          // It is given back with the marks, after the run reads the document again.
          const saved = old.entry.saved;
          if (saved !== undefined && options.stageOnly !== true && placed(doc) && (doc.icon !== saved.icon || doc.color !== saved.color)) restores.push({doc, saved, path: old.path, entry: old.entry});
          const changedFile = removeBody(old.path);
          const retained = keptForLane(old.entry);
          if (!retained) ids.delete(old.path);
          documentIds.delete(old.path);
          if (!retained || changedFile) result.removed.push(old.path);
        }
        continue;
      }
      const path = paths.get(doc.id)!;
      if (limited.has(doc.id)) continue;
      // The title names the file, its `ids` key and the report's line: a name the record does not hold yet is
      // shown to the hooks first. Until they pass it, the document keeps its accepted path or, when it has none,
      // a name made from its id, also in place of a path an earlier run recorded for it without a file.
      if (gate.configured && !previous.has(path)) {
        const findings = await checkTitle(gate, path, doc.title);
        if (findings === null) {
          result.leftOut.push({id: doc.id, rule: 'security-unchecked'});
          resetTarget(doc.id);
          continue;
        }
        if (findings.length > 0) {
          let held = old !== undefined && previous.has(old.path) ? old.path : undefined;
          if (held === undefined) {
            const available = new Set(reservations);
            if (old !== undefined) available.delete(old.path);
            held = documentPath(folderFor(doc)!, doc.id, doc.id, available, undefined, (candidate) => invalidZone(doc, candidate));
            reservations.add(held);
            if (old !== undefined && old.path !== held) ids.delete(old.path);
          }
          recordBlocked(doc, held, findings, held);
          continue;
        }
      }
      const prior = splitFile(old === undefined ? '' : previous.get(old.path)?.toString('utf8') ?? '');
      const head = old !== undefined && path !== old.path && annotationHead(old.path) !== undefined ? relocatedHead(prior.head) : prior.head;
      try {
        const {text: body, previousBody} = readable.get(doc.id)!;
        const assets = await downloadAssets(path, body, uploads, previousBody, old?.path, new Set(old?.entry.plainFiles));
        const candidate: Candidate = {doc, path, head, assets, files: new Map<string, FileContent>([[path, joinFile(head, assets.body)], ...assets.files])};
        if (old?.path === path && previousBody !== undefined) candidate.previousBody = previousBody;
        candidates.set(doc.id, candidate);
        resetTarget(doc.id);
        if (old !== undefined) documentIds.delete(old.path);
        documentIds.set(path, doc.id);
      } catch (error) {
        if (error instanceof LinearError || error instanceof GitLfsMissingError) throw error;
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
        if (error instanceof MarkdownLimitError) result.leftOut.push({id: doc.id, rule: 'markdown-complexity'});
        else if (error instanceof AttachmentBudgetError) result.leftOut.push({id: doc.id, rule: 'attachment-budget'});
        else if (error instanceof ImageRepairBudgetError) result.leftOut.push({id: doc.id, rule: 'image-repair-budget'});
        else if (error instanceof DownloadRetryError) result.leftOut.push({id: doc.id, rule: 'download-retry'});
        else result.leftOut.push({id: doc.id, rule: 'capture-translation'});
      }
    }
    // The file already holds this text, and the document shows no mark: it is recorded without asking the hooks.
    const recordedAsIs = (candidate: Candidate, text: string) => {
      const old = byId.get(candidate.doc.id);
      const {assets} = candidate;
      return assets.observedBody === undefined && old?.path === candidate.path && old.entry.saved === undefined && previous.get(candidate.path)?.equals(Buffer.from(text)) === true && assets.files.size === 0 && assets.uploads.size === 0;
    };
    // A rejected target may change other documents' relative links. Recheck
    // only bodies that change as targets fall back to their accepted paths.
    // A candidate's text with its links written against these targets. A text that would link or embed a file the
    // asset checks did not read throws, unless `staged`: a link variant is only shown to the hooks, never recorded.
    const textOf = (candidate: Candidate, targets: ReadonlyMap<string, string>, staged = false) => {
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
      // Linear's own spelling of the same document is no change: keep the file's text, also when its files are
      // downloaded again (the same Markdown links the same paths). A change of spelling alone would read as an edit
      // in Linear. A changed document is written in the form the `linear-format` hook leaves as it is.
      // Compared again only when other link targets change the body.
      if (candidate.compared?.body !== body) {
        const unchanged = candidate.previousBody !== undefined && sameAsLinear(body, candidate.previousBody);
        const text = unchanged ? joinFile(candidate.head, candidate.previousBody!) : fixLinearText(joinFile(candidate.head, body), readable.get(candidate.doc.id)?.text ?? candidate.doc.content ?? '', linkedFileCheck(candidate.path, (file) => mapping.files.has(file)), candidate.previousBody);
        // The asset checks read `body`: the file may link or embed no file they did not see there.
        let addsFiles = false;
        if (!unchanged) {
          try { checkFileTargets(candidate.path, body, splitFile(text).body); } catch (error) {
            if (!(error instanceof FileTargetsAddedError)) throw error;
            addsFiles = true;
          }
        }
        candidate.compared = {body, text, addsFiles};
      }
      if (candidate.compared.addsFiles && !staged) throw new FileTargetsAddedError();
      return candidate.compared.text;
    };
    let again = true;
    while (again) {
      again = false;
      for (const [id, candidate] of candidates) {
        const {doc, path, head, assets} = candidate;
        const old = byId.get(id);
        let text: string;
        let observed: string | undefined;
        try {
          text = textOf(candidate, documentIds);
          if (assets.observedBody !== undefined) {
            const observedCandidate = {...candidate, assets: {...assets, body: assets.observedBody}};
            delete observedCandidate.compared;
            observed = textOf(observedCandidate, documentIds);
          }
        } catch (error) {
          if (!(error instanceof MarkdownLimitError || error instanceof FileTargetsAddedError)) throw error;
          result.leftOut.push({id, rule: error instanceof FileTargetsAddedError ? 'capture-translation' : 'markdown-complexity'});
          candidates.delete(id);
          resetTarget(id);
          again = true;
          break;
        }
        if (Buffer.byteLength(text) > MAPPING_FILE_BYTES || (observed !== undefined && Buffer.byteLength(observed) > MAPPING_FILE_BYTES)) {
          result.leftOut.push({id, rule: 'blob-too-large'});
          candidates.delete(id);
          resetTarget(id);
          again = true;
          break;
        }
        candidate.files.set(path, text);
        if (candidate.checked === text && candidate.observed === observed) continue;
        let findings: SecurityFinding[] | null = [];
        if (!recordedAsIs(candidate, text)) {
          // Upload URLs also enter the cache ref. Scan the original text so
          // localization cannot hide a secret embedded in a URL or its query.
          const original = withNewUploadUrls(head + (doc.content ?? ''), assets.uploads, uploads) + ((assets.plainFiles?.length ?? 0) === 0 ? '' : `\n${assets.plainFiles!.join('\n')}\n`);
          if (original !== text) findings = await gate.check(new Map<string, FileContent>([[path, original], ...assets.files]));
          if (findings?.length === 0) findings = await gate.check(candidate.files);
          if (findings?.length === 0 && observed !== undefined) {
            if (observed !== text && observed !== original) findings = await gate.check(new Map([[path, observed], ...assets.files]));
            // The pull request step asks about the repaired text alone (`repairSet`): with the downloaded files
            // beside it, this run's check is another set, which the staged steps would not answer.
            if (findings?.length === 0 && candidate.files.size > 1) findings = await gate.check(repairSet(path, text));
          }
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
          // A document read again only because another version read it, unchanged in Linear, keeps its recorded
          // reading quietly: no one edited it, so it gets no blocked mark. The version is noted.
          if (reread.has(id) && asRecorded(doc) && old !== undefined) ids.set(old.path, {...old.entry, capturedWith: VERSION});
          else recordBlocked(doc, path, findings);
          candidates.delete(id);
          again = true;
          break;
        }
        candidate.checked = text;
        if (observed !== undefined) candidate.observed = observed;
      }
    }
    // The stage step stops here: the reads it kept end, and the rest of the run reads Linear itself.
    linear.transport.reads?.end();
    if (options.stageOnly === true) {
      // The staging gate passed every candidate. The apply step rejects some,
      // and the documents that link to them are written with the rejected
      // targets' fallback links: stage those texts too, or they would wait
      // for an answer on every run while the target stays rejected.
      // The documents the hooks refused before come first: those that link them make progress on every run.
      const refused = new Set([...candidates.keys()].filter((id) => { const saved = byId.get(id)?.entry.saved; return saved !== undefined && saved.notice?.kind !== 'conflict'; }));
      const budget = linkVariantBudget();
      // A variant that would add a file is staged too: the capture that falls back to it leaves the document out.
      if (linkBase !== undefined) for (const set of linkVariants(candidates, (candidate, targets) => textOf(candidate, targets, true), resetTargets, documentIds, {refused, settled: recordedAsIs, budget})) await gate.check(set);
      result.summary = `Staged ${candidates.size} changed documents for the security hooks.`;
      if (budget.short === true) result.summary += ` ${message('sync.link-variant-budget')}`;
      return result;
    }
    // A mark saves and restores a document's icon and color and comments on
    // it, by id, wherever the document is. Its copy here was read earlier in
    // the run (in the apply step, by the stage step), and a Linear member may
    // have moved, trashed or archived it since. The documents whose mark may
    // change, and those in the trash or archive whose own decoration is due
    // back, are read again. Only one still in the place it was read in (and,
    // to be marked, still live) is changed. Any other is reported, and the
    // held cursor lets the next run read it again: a blocked one keeps its
    // entry as the run found it. A blocked one is marked over its current
    // decoration; any other that changed since keeps its mark until the next
    // run captures it.
    const unmarked = new Set<string>();
    const marking = new Set([
      ...result.blocked.map(({id}) => id),
      ...[...candidates].filter(([id, {doc}]) => byId.get(id)?.entry.saved !== undefined || detectConflicts(doc.content ?? '').length > 0).map(([id]) => id),
    ]);
    // The apply step reads every one of them, as its copies are the stage step's. A single-step run read them
    // itself a moment ago: it reads again only those whose mark would change something in Linear.
    const writes = (id: string) => {
      const blocked = result.blocked.find((item) => item.id === id);
      const doc = blocked === undefined ? candidates.get(id)?.doc : documents.get(id);
      const entry = blocked === undefined ? byId.get(id)?.entry ?? {id} : ids.get(blocked.path);
      return doc === undefined || entry === undefined || markWritesLinear(doc, entry, blocked?.findings);
    };
    const rereading = new Set([...[...marking].filter((id) => linear.transport.reads?.mode === 'replay' || writes(id)), ...restores.map(({doc}) => doc.id)]);
    const current = rereading.size === 0 ? new Map<string, LinearDocument>() : new Map((await linear.getDocuments([...rereading])).map((doc) => [doc.id, doc]));
    const samePlace = (now: LinearDocument | undefined, then: LinearDocument | undefined): now is LinearDocument =>
      now !== undefined && then !== undefined && placed(now) && placeKeyOf(now) === placeKeyOf(then);
    const stillThere = (now: LinearDocument | undefined, then: LinearDocument | undefined): now is LinearDocument =>
      samePlace(now, then) && !now.trashed && now.archivedAt === null;
    const leaveUnmarked = (id: string, then: LinearDocument | undefined) => {
      const now = current.get(id);
      unmarked.add(id);
      result.leftOut.push({id, rule: 'changed-during-run'});
      // Later steps (the hold marks, the write step's restore) read where the document is from this map.
      if (now !== undefined && placed(now)) documents.set(id, {...now, content: then?.content ?? null});
      else documents.delete(id);
    };
    for (const {doc, saved, path, entry} of restores) {
      const now = current.get(doc.id);
      if (samePlace(now, doc) && (now.trashed || now.archivedAt !== null)) {
        if (now.icon !== saved.icon || now.color !== saved.color) await linear.updateDocument(doc.id, {icon: saved.icon, color: saved.color});
        continue;
      }
      // Not the run's to give back now: its file and entry, with the saved decoration, stay as the run found them, so a
      // later run that finds it in place again still has the decoration to give back.
      result.leftOut.push({id: doc.id, rule: 'changed-during-run'});
      changes.delete(path);
      result.removed = result.removed.filter((removed) => removed !== path);
      ids.set(path, entry);
    }
    for (const blocked of [...result.blocked]) {
      if (!rereading.has(blocked.id)) continue;
      const now = current.get(blocked.id);
      const then = documents.get(blocked.id);
      if (!stillThere(now, then)) {
        result.blocked.splice(result.blocked.indexOf(blocked), 1);
        leaveUnmarked(blocked.id, then);
        // The entry stays as the run found it: no saved decoration without a mark behind it.
        for (const [path, entry] of ids) if (entry.id === blocked.id) ids.delete(path);
        const old = byId.get(blocked.id);
        if (old !== undefined) ids.set(old.path, old.entry);
        continue;
      }
      if (now.updatedAt === then!.updatedAt) continue;
      documents.set(blocked.id, {...now, content: then!.content ?? null});
      const entry = ids.get(blocked.path);
      if (entry !== undefined && byId.get(blocked.id)?.entry.saved === undefined) ids.set(blocked.path, {...entry, saved: {icon: now.icon, color: now.color}});
    }
    // A candidate's text was read and checked while it was in place, and other texts of this run link it where it
    // was: it is captured as read. Only its mark waits.
    for (const [id, {doc}] of candidates) {
      if (!rereading.has(id)) continue;
      const now = current.get(id);
      if (!stillThere(now, doc)) leaveUnmarked(id, doc);
      else if (now.updatedAt !== doc.updatedAt) unmarked.add(id);
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
        // Read with that version's body as evidence for the marker escapes Linear dropped, as the capture reads it.
        assets = await captureAtBaseline(candidate.path, linearMarkersAsText(candidate.doc.content ?? '', body), uploads, body, candidate.path, new Set(byId.get(candidate.doc.id)?.entry.plainFiles));
        // Linear's spelling of that version reads back as its text.
        return assets.files.size === 0 && textOf({doc: candidate.doc, path: candidate.path, head, assets, files: new Map(), previousBody: body}, documentIds) === baseline.text;
      } catch (error) {
        if (error instanceof MarkdownLimitError || error instanceof ImageRepairBudgetError || error instanceof FileTargetsAddedError) return false;
        // An image that version did not have: the document changed.
        if (error instanceof DownloadRetryError && error.cause instanceof NotDownloaded) return false;
        throw error;
      }
    };
    // The documents whose entry this capture records anew: only their repairs are this capture's to sign.
    const recordedNow = new Set<string>();
    for (const [id, candidate] of candidates) {
      const old = byId.get(id);
      const converged = reread.has(id) && readsAsTracked(candidate.path, String(candidate.files.get(candidate.path)));
      // The lane takes the tracked file for it, though the record may hold this reading already.
      if (converged) (result.rereadAsTracked ??= []).push(candidate.path);
      if (old?.path === candidate.path && !converged && await asLastAccepted(candidate)) {
        // The reading stays as recorded; the version that read it again is noted, so it is not read on every run.
        if (reread.has(id)) ids.set(old.path, {...old.entry, capturedWith: VERSION});
        continue;
      }
      recordedNow.add(id);
      if (old !== undefined && old.path !== candidate.path) {
        removeBody(old.path);
        ids.delete(old.path);
        result.removed.push(old.path);
      }
      // Only a suspended document needs the version of its reading: noting it on every entry would rewrite them all. One
      // that reads as the tracked file keeps the older version until the lane takes that file (`rereadAsTracked`): the
      // lane notes the version with its push, so a run that stops before it reads the document again.
      const entry = {...old?.entry, id, observedDigest: observedDigest(candidate.doc), ...(old?.entry.suspended === undefined || converged ? {} : {capturedWith: VERSION})};
      delete entry.pullRewrite;
      const plainFiles = [...new Set([...(old?.entry.plainFiles ?? []), ...(candidate.assets.plainFiles ?? [])])];
      if (plainFiles.length > 0) entry.plainFiles = plainFiles;
      const repaired = candidate.files.get(candidate.path)!;
      if (candidate.observed !== undefined) {
        const observed = candidate.observed;
        candidate.files.set(candidate.path, observed);
        const deadUploads = candidate.assets.deadUploads ?? [];
        entry.pullRewrite = {hash: createHash('sha256').update(observed).digest('hex'), observedHash: createHash('sha256').update(candidate.doc.content ?? '').digest('hex'), replacement: String(repaired),
          // The images are counted in the text the capture read; the digest stays on Linear's content.
          images: imageLinks(readable.get(id)?.text ?? candidate.doc.content ?? '', new Set(deadUploads)).images};
        const recorded = old === undefined ? undefined : signedRepair(context.pushedKey, old.path, old.entry);
        if (recorded?.hash === entry.pullRewrite.hash && recorded.source !== undefined) entry.pullRewrite.source = recorded.source;
        entry.pullRewrite = signRepair(context.pushedKey, candidate.path, id, entry.pullRewrite);
      }
      ids.set(candidate.path, entry);
      for (const [path, content] of candidate.files) {
        // A record can retain a git-only excluded file without sending it to
        // Linear. Compare against the last accepted state, not an intervening
        // record that also retained the excluded bytes.
        const prior = previous.get(path);
        // A newer reading that is what the tracked branch holds is recorded even where it matches the last accepted
        // text: the recorded one is the older reading its lane holds.
        if (path === candidate.path && old?.path === path && prior !== undefined && excludedPath(path) && !converged) {
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
    const through = missingBodies || result.leftOut.length > 0 || held.size > 0 ? cursor : [...listed.values()].map(normalizedTime).sort().at(-1) ?? cursor;
    // Without the cache (lost, or never recorded yet), the write step uploads every linked file again; this mark tells it.
    const uploadsCommit = await commitUploads(git, state.uploads, uploads, identity, context.pushedKey, state.uploads === null ? { message: UPLOADS_REBUILDING, always: true } : {});
    const prepared = await prepareLfs(git, fetched.tracked, changes);
    const plainTrailers = [...ids.values()].flatMap(entry => (entry.plainFiles ?? []).map(target => `Plain-link: ${encodeURIComponent(entry.id)} ${encodeURIComponent(target)}`));
    const linearCommit = await commitTree(git, { parents: [base], base, changes: prepared.changes, message: CAPTURE_MESSAGE + (plainTrailers.length === 0 ? '' : `\n\n${plainTrailers.join('\n')}`), identity, sign: signObservation(context.pushedKey) });
    if (linearCommit !== base) await checkMappingBudget(git, linearCommit, ids);
    for (const [path, entry] of ids) if (recordedNow.has(entry.id) && entry.pullRewrite !== undefined && entry.pullRewrite.source === undefined) {
      ids.set(path, {...entry, pullRewrite: signRepair(context.pushedKey, path, entry.id, {...entry.pullRewrite, source: linearCommit})});
    }
    // Record a held removal, and a cleared one, so the next capture reads what this one held.
    // Capture also writes a cursor after its first complete read of legacy state,
    // even when the content is unchanged.
    const recordsChange = linearCommit !== base || uploadsCommit !== state.uploads;
    const recordsRemovals = held.size > 0 || heldBefore.size > 0;
    const writeCursor = through !== null && (needsCursor || recordsChange || recordsRemovals);
    // During a partial upgrade, keep the progress of bodies accepted by this capture.
    const checkpoints = new Map<string, string>();
    if (needsCursor && through === null) for (const id of recordedNow) {
      const doc = candidates.get(id)!.doc;
      if (doc.content !== undefined) checkpoints.set(id, doc.updatedAt);
    }
    const trailers = [
      ...(writeCursor ? [captureCursorTrailer(through)] : []),
      ...recordedTrailers(checkpoints),
      ...[...held].filter((id) => /^\S+$/.test(id)).sort().map((id) => `Removal-held: ${id}`),
    ];
    const commitMessage = trailers.length === 0 ? 'Capture document ids' : `Capture document ids\n\n${trailers.join('\n')}`;
    const always = recordsRemovals || checkpoints.size > 0 || (writeCursor && through !== cursor);
    const idsCommit = await commitIds(git, state.ids, ids, identity, {
      message: commitMessage, always, reserved, superseded,
      ...(writeCursor || checkpoints.size > 0 ? { sign: signIdsTrailers(context.pushedKey, linearCommit) } : {}),
    });
    // Upload accepted LFS objects before publishing pointers; no blocked bytes reach this step.
    await lfsPush(git, lfsRemote(options.config), prepared.oids);
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
            includeUpdatedBody: before.saved !== undefined && blocked.length === 0 && before.observedDigest !== undefined,
            onConflictNotice: (change) => result.conflictNotices[change].push(path),
            persistEntry: async (entry, cleared) => {
              // Clearing a mark can advance updatedAt. Refresh the digest only from a response holding the
              // same accepted body, because a Linear edit may have arrived while the mark was cleared.
              if (cleared !== undefined && matchesObservedBody(cleared, doc)) {
                entry = {...entry, observedDigest: observedDigest(cleared)};
              }
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

/** At most this many of a text's changed link targets are staged alone, refused ones first; the text with all of them rejected is always staged. */
export const LINK_VARIANT_LINKS = 8;

/**
 * What staging texts with rejected link targets may spend in one run: the
 * sets it stages, and the work of writing their texts (each text's
 * characters, the link targets copied for it and the targets rejected in
 * it), spent before each text is written. Past it, the rest is not staged:
 * a document whose text with a refused target has no answer is left out of
 * the run, and `short` is set.
 */
export interface LinkVariantBudget { sets: number; work: number; short?: boolean }
export const linkVariantBudget = (): LinkVariantBudget => ({sets: 256, work: 32 * 1024 * 1024});

export interface LinkVariantOptions<C> {
  /** Targets the hooks refused before: the texts with them rejected are staged first, so the documents that link them make progress run after run. */
  refused?: ReadonlySet<string>;
  /** A text the operation records without asking the hooks (the file already holds it): not staged. */
  settled?: (candidate: C, text: string) => boolean;
  budget?: LinkVariantBudget;
}

/**
 * The sets of files each candidate would be checked with when some of the
 * other candidates it links to are rejected: its text with those targets'
 * fallback links, and its embedded files. Made one at a time, within the
 * budget. `reset` rejects a set of targets in a copy of `documentIds`.
 */
export function* linkVariants<C extends { path: string; files: Map<string, FileContent> }>(
  candidates: ReadonlyMap<string, C>,
  textOf: (candidate: C, targets: ReadonlyMap<string, string>) => string,
  reset: (ids: ReadonlySet<string>, targets: Map<string, string>) => void,
  documentIds: ReadonlyMap<string, string>,
  options: LinkVariantOptions<C> = {},
): Generator<Map<string, FileContent>> {
  const budget = options.budget ?? linkVariantBudget();
  const refused = [...candidates.keys()].filter((id) => options.refused?.has(id) === true);
  // With targets refused before, every candidate first gets one text, the one with all of them rejected: the text it
  // needs when the hooks refuse them again. Then each of them alone, then every target, refused ones still first.
  // Candidates refused themselves come last in each pass: their own text is likely refused again, and their texts
  // must not use up the budget of the documents that link them.
  const passes: Array<{ targets: string[]; allOnly: boolean }> = refused.length > 0
    ? [{targets: refused, allOnly: true}, {targets: refused, allOnly: false}, {targets: [...new Set([...refused, ...candidates.keys()])], allOnly: false}]
    : [{targets: [...candidates.keys()], allOnly: false}];
  const order = [...candidates].sort(([a], [b]) => Number(options.refused?.has(a) === true) - Number(options.refused?.has(b) === true));
  const staged = new Map<string, Set<string>>();
  // The candidates whose text a pass's targets leave as it is, by the targets: a later pass over the same targets skips them.
  const unlinked = new Map<readonly string[], Set<string>>();
  for (const pass of passes) {
    const passUnlinked = unlinked.get(pass.targets) ?? new Set<string>();
    unlinked.set(pass.targets, passUnlinked);
    for (const [id, candidate] of order) {
      if (passUnlinked.has(id)) continue;
      if (budget.sets <= 0) { budget.short = true; return; }
      const accepted = candidate.files.get(candidate.path) as string;
      // The candidate's text with the `rejected` targets' fallback links; undefined once the budget is spent, and
      // null when that text is past the Markdown limits: it is not staged, and the run that would write it leaves the
      // document out. Its work is spent all the same.
      // With `free`, a text that cannot be staged (the accepted one, or the one the file already holds) costs
      // nothing: candidates that link none of the targets, or whose text is already recorded, cannot use up
      // the budget of the others on every run while the cursor holds. Their work stays one text per pass.
      const without = (rejected: readonly string[], free = false): string | null | undefined => {
        const cost = accepted.length + documentIds.size + rejected.length;
        if (budget.work < cost) { budget.short = true; return undefined; }
        const targets = new Map(documentIds);
        reset(new Set(rejected), targets);
        let text: string;
        try {
          text = textOf(candidate, targets);
        } catch (error) {
          if (!(error instanceof MarkdownLimitError)) throw error;
          budget.work -= cost;
          return null;
        }
        if (!(free && (text === accepted || options.settled?.(candidate, text) === true))) budget.work -= cost + Math.max(0, text.length - accepted.length);
        return text;
      };
      const others = pass.targets.filter((other) => other !== id);
      if (others.length === 0) continue;
      const all = without(others, true);
      if (all === undefined) continue;
      if (all === accepted) { passUnlinked.add(id); continue; }
      // The targets it links, found by halving the groups whose rejection changes its text: a text that links
      // a few of many candidates costs a few texts per link, not one per candidate. A group's change is in one
      // of its halves: when the first leaves the text as it is, the second has the group's text. A group whose text
      // is past the Markdown limits (null) may still link targets whose texts fit: its halves are searched too.
      const alone = new Map<string, string>();
      const find = (group: readonly string[], text: string | null | undefined): void => {
        if (text === undefined || text === accepted || alone.size >= LINK_VARIANT_LINKS) return;
        if (group.length === 1) { if (text !== null) alone.set(group[0]!, text); return; }
        const first = group.slice(0, group.length >> 1);
        const second = group.slice(group.length >> 1);
        const firstText = without(first);
        if (firstText === undefined) return;
        if (firstText === accepted) { find(second, text); return; }
        find(first, firstText);
        if (alone.size >= LINK_VARIANT_LINKS) return;
        find(second, without(second));
      };
      if (!pass.allOnly) find(others, all);
      const texts = new Set(all === null ? alone.values() : [...alone.values(), all]);
      // A few targets: also every combination of two or more of them. All of them is the text with every target
      // rejected, unless that one is past the Markdown limits.
      const linked = [...alone.keys()];
      if (linked.length <= LINK_VARIANT_TARGETS) {
        for (let mask = 1; mask < 2 ** linked.length - (all === null ? 0 : 1); mask += 1) {
          const rejected = linked.filter((_, bit) => (mask >> bit) & 1);
          if (rejected.length < 2) continue;
          const text = without(rejected);
          if (text === undefined) break;
          if (text !== null) texts.add(text);
        }
      }
      const done = staged.get(id) ?? new Set<string>();
      staged.set(id, done);
      for (const text of texts) {
        const hash = createHash('sha256').update(text).digest('hex');
        if (text === accepted || done.has(hash) || options.settled?.(candidate, text) === true) continue;
        if (budget.sets <= 0) { budget.short = true; return; }
        budget.sets -= 1;
        done.add(hash);
        yield new Map([...candidate.files, [candidate.path, text]]);
      }
    }
  }
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
  for (const item of result.leftOut) if (item.rule === 'image-repair-budget') summary += `\nimage-repair-budget: ${JSON.stringify(item.id)}. Image or link repair exceeded the document limit; simplify or split the document and retry. The cursor is held.`;
  for (const item of result.leftOut) if (item.rule === 'blob-too-large') summary += `\nblob-too-large: ${JSON.stringify(item.id)}. The Markdown file exceeds the byte limit. Any previous file stays in place and the cursor is held.`;
  for (const item of result.leftOut) if (item.rule === 'download-retry') summary += `\ndownload-retry: ${JSON.stringify(item.id)}. An upload could not be downloaded; the next run will retry.`;
  for (const item of result.leftOut) if (item.rule === 'changed-during-run') summary += `\nchanged-during-run: ${JSON.stringify(item.id)}. The document left the place the run read it in, or was trashed or archived, before the run marked it or gave back its decoration: the run leaves its decoration as it is, and the next run reads it again.`;
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
    const written = [...changes].filter(([, content]) => content !== null);
    if (written.length === 0) return { changes: result, oids: [] };
    await git.run(['read-tree', tracked], { env });
    // One call for every path: `check-attr -z` answers `<path>\0filter\0<value>\0` for each, in order.
    const attributes = (await git.run(['check-attr', '--cached', '-z', '--stdin', 'filter'], { input: written.map(([path]) => `${path}\0`).join(''), env })).stdout.toString('utf8').split('\0');
    for (const [index, [path, content]] of written.entries()) {
      if (content === null) continue;
      if (attributes[index * 3 + 2] !== 'lfs') continue;
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

import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { end, isCallout, parse, start, visit } from '../../../src/format/markdown.ts';
import type { LinearClient, LinearDocument } from '../../../src/linear/index.ts';
import { redactUploadUrls } from './comparison-evidence.ts';
import { COMPLEXITY_PER_REQUEST, type Governor } from './governor.ts';
import { loadHeldRun, type HeldRun } from './held-run.ts';
import { runNames } from './isolation.ts';
import { acquireLock } from './locks.ts';
import { ownedDocuments } from './ownership.ts';
import { runTeamZones } from './runner.ts';
import type { Scenario } from './spec.ts';

const REPORT_FILE = 'read-bodies.json';
const PAGE_SIZE = 25;
const PREVIEW_LINES = 20;
const PREVIEW_CHARACTERS = 2000;

function bodyEvidence(document: LinearDocument) {
  const body = document.content ?? '';
  const tree = parse(body);
  const definitions = new Map<string, string>();
  visit(tree, (node) => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });
  const images = new Set<string>();
  const tables: string[] = [];
  const diagrams: string[] = [];
  const callouts: string[] = [];
  visit(tree, (node) => {
    if (node.type === 'image') images.add(node.url);
    if (node.type === 'imageReference') {
      const url = definitions.get(node.identifier);
      if (url !== undefined) images.add(url);
    }
    if (node.type === 'table') tables.push(body.slice(start(node), end(node)));
    if (node.type === 'code' && node.lang?.toLowerCase() === 'mermaid') diagrams.push(body.slice(start(node), end(node)));
    if (isCallout(node, body)) callouts.push(body.slice(start(node), end(node)));
  });
  return {
    title: redactUploadUrls(document.title),
    firstScreen: redactUploadUrls(body.split('\n', PREVIEW_LINES).join('\n')).slice(0, PREVIEW_CHARACTERS),
    images: [...images].map((url) => ({ url: redactUploadUrls(url), host: URL.parse(url)?.hostname || null })),
    tables: tables.map(redactUploadUrls),
    diagrams: diagrams.map(redactUploadUrls),
    callouts: callouts.map(redactUploadUrls),
  };
}

interface ReadBodiesDeps {
  stateDir: string;
  scenarios: readonly Scenario[];
  readIds(held: HeldRun): Promise<ReadonlyMap<string, string>>;
  connect(held: HeldRun): Promise<{ client: Pick<LinearClient, 'getDocuments'>; governor: Pick<Governor, 'admit'> }>;
}

function requireActiveHold(held: HeldRun): void {
  if (!Number.isFinite(held.holdUntil) || held.holdUntil <= Date.now()) throw new Error('the run hold has ended');
}

export async function readHeldBodies(runDir: string, paths: readonly string[] | undefined, deps: ReadBodiesDeps): Promise<number> {
  const { runId, teamZonePrefix } = runNames(loadHeldRun(runDir).runId);
  // Use the same lock as ui-result and recover, so cleanup cannot race the read.
  const lock = await acquireLock(`ui-result-${runId}`, { stateDir: deps.stateDir, runId, timeoutMs: 0 });
  try {
    const held = loadHeldRun(runDir);
    if (held.runId !== runId) throw new Error('the held run changed while taking its lock');
    requireActiveHold(held);
    const owner = held.observations.get('admission.owner');
    if (typeof owner !== 'string' || owner === '') throw new Error('the held run has no shared reservation owner');
    const scenario = deps.scenarios.find((candidate) => candidate.id === held.scenarioId);
    if (scenario === undefined) throw new Error('the held run scenario is missing from the harness catalog');

    const ids = await deps.readIds(held);
    if (ids.size === 0) throw new Error('the held run has no documents in its ids state ref');
    const selected = paths === undefined ? [...ids.keys()].sort() : [...new Set(paths)];
    const byPath = selected.map((path) => {
      const id = ids.get(path);
      if (id === undefined) throw new Error('a requested path has no document in the held run');
      return { path, id };
    });

    const { client, governor } = await deps.connect(held);
    const projects = new Set([...held.live.projects.values()].map(({ id }) => id));
    const teams = new Set(runTeamZones(held.live.tree, held.live.teams).ids);
    const owned = ownedDocuments({ stateDir: deps.stateDir, runId });
    const wanted = [...new Set(byPath.map(({ id }) => id))];
    const requests = Math.ceil(wanted.length / PAGE_SIZE);
    requireActiveHold(held);
    const grant = await governor.admit(scenario, runId, { requests, complexity: requests * COMPLEXITY_PER_REQUEST }, held.appName, owner)
      .catch((cause: unknown) => { throw new Error('could not obtain admission for the held run', { cause }); });
    if (grant.owner !== owner || grant.app.name !== held.appName) throw new Error('admission did not match the held run');
    // This is the run's retained reservation. ui-result or recovery releases it.
    requireActiveHold(held);
    const documents = await client.getDocuments(wanted, { withContent: true, pageSize: PAGE_SIZE })
      .catch((cause: unknown) => { throw new Error('could not read the held run documents from Linear', { cause }); });
    requireActiveHold(held);
    const byId = new Map(documents.map((document) => [document.id, document]));
    const evidence = byPath.map(({ path, id }) => {
      const document = byId.get(id);
      if (document === undefined || document.content === undefined || document.trashed || document.archivedAt !== null) {
        throw new Error('a requested document is missing, archived, or has no returned content');
      }
      const belongsToRun = document.projectId === null
        ? document.teamId !== null && teams.has(document.teamId) && (document.title.startsWith(teamZonePrefix) || owned.get(id) === true)
        : projects.has(document.projectId);
      if (!belongsToRun) throw new Error('a requested document is outside the held run');
      return { path, ...bodyEvidence(document) };
    });
    const temporary = mkdtempSync(join(runDir, '.read-bodies-'));
    try {
      const file = join(temporary, REPORT_FILE);
      writeFileSync(file, `${JSON.stringify({ runId, scenarioId: held.scenarioId, documents: evidence }, null, 2)}\n`, { mode: 0o600 });
      renameSync(file, join(runDir, REPORT_FILE));
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
    return evidence.length;
  } finally {
    lock.release();
  }
}

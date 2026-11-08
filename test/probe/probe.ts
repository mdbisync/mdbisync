// The zero-trust format probe: writes every bank fixture to a Linear document,
// reads it back, writes the readback and reads again, decodes the stored Yjs
// state, and measures the limits the engine depends on. Linear's refusals are
// findings, recorded in the result, never hidden.

import {
  LinearClient,
  LinearGraphQLError,
  LinearStoppedError,
  LinearUploadError,
  type RateLimitSnapshot,
} from '../../src/linear/index.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  contentTypeOf,
  fromLinear,
  linkedAssets,
  probedFixtures,
  readFixture,
  toLinear,
  type AssetMap,
  type Bank,
  type BankFixture,
} from './bank.ts';
import { summarizeContentState, type YjsSummary } from './yjs-summary.ts';

/** Probe projects are named with this prefix and the run id; neutral work text. */
export const PROJECT_PREFIX = 'Format probe ';
/** Leftover probe projects older than this are removed at the start of a run. */
export const SWEEP_AGE_MS = 2 * 60 * 60 * 1000;
/** Documents per read-back request; content state is several times the Markdown's size. */
export const READ_PAGE_SIZE = 20;

export interface FixtureResult {
  file: string;
  group: string;
  construct: string;
  class: BankFixture['class'];
  rule?: string | undefined;
  basis: BankFixture['basis'];
  /** The fixture as stored in the bank. */
  source: string;
  /** Linear refused the first write; the error code and message. */
  refused?: string;
  /** Linear's form after the first write, asset URLs mapped back to bank paths. */
  first?: string;
  /** Linear's form after writing `first` back. */
  second?: string;
  /** The second readback equals the first byte for byte. */
  fixedPoint?: boolean;
  /** Whether `documentCreate`'s payload held the content the read returned. */
  createReturnedStored?: boolean;
  /** Whether `documentUpdate`'s payload held the content the read returned. */
  updateReturnedStored?: boolean;
  /** Linear refused writing the first readback back. */
  secondRefused?: string;
  yjs?: YjsSummary;
  /** Why the Yjs state could not be read or decoded. */
  yjsError?: string;
  /** The decoded state is the same after the second write. */
  yjsStable?: boolean;
}

export interface LimitFact {
  /** Largest accepted value, or the largest tried when nothing was refused. */
  accepted: number;
  /** Smallest refused value, when one was found. */
  refused?: number;
  refusal?: string;
  tries: number;
}

export interface ProbeFacts {
  titleLength?: LimitFact;
  contentLength?: LimitFact;
  /** How the content limit counts: tried with characters of different widths at the limit. */
  contentUnit?: { utf16Units: string; utf8Bytes: string; codePoints: string };
  uploads?: Array<{ declaredBytes: number; outcome: string }>;
  mutationsReturnStoredContent?: { create: { same: number; different: number }; update: { same: number; different: number } };
  trashed?: Record<string, string>;
  teamFilterIncludesProjectDocuments?: boolean;
  projectDocumentHasTeam?: boolean;
  complexity?: Array<{ query: string; first: number; complexity: number | undefined; outcome: string }>;
  rateLimitHeaders?: Record<string, string>;
  rateLimitStatus?: unknown;
}

export interface ProbeRun {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  fixtures: FixtureResult[];
  facts: ProbeFacts;
  uploads: Array<{ file: string; outcome: string }>;
  /** Yjs reading was unavailable for the whole run (the field disappeared). */
  yjsBlocked?: string;
  cleanup: string[];
  requests?: unknown;
}

export interface ProbeOptions {
  client: LinearClient;
  bank: Bank;
  runId: string;
  teamKey?: string | undefined;
  /** Probe only fixtures whose path contains this text. */
  only?: string | undefined;
  /** Measure limits and query costs as well (about 60 requests). */
  facts?: boolean;
  /** Complexity per response, filled by the caller's transport hook. */
  complexityLog?: Map<string, number | undefined>;
  log?: (line: string) => void;
  now?: () => number;
}

interface ReadDocument {
  id: string;
  content: string | null;
  contentState?: string | null;
  trashed: boolean | null;
  archivedAt: string | null;
  team: { id: string } | null;
}

export async function runProbe(options: ProbeOptions): Promise<ProbeRun> {
  const { client, bank, runId } = options;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const run: ProbeRun = { runId, startedAt: new Date(now()).toISOString(), fixtures: [], facts: {}, uploads: [], cleanup: [] };

  const teamId = await findTeam(client, options.teamKey);
  await sweepLeftovers(client, now(), run, log);
  const projectId = await createProject(client, `${PROJECT_PREFIX}${runId}`, teamId);
  log(`project created for run ${runId}`);
  try {
    const fixtures = probedFixtures(bank).filter((f) => options.only === undefined || f.file.includes(options.only));
    const sources = fixtures.map((fixture) => readFixture(bank, fixture));
    const assets = await uploadAssets(client, bank, sources, run, log);
    await probeFixtures(client, projectId, fixtures, sources, assets, run, log);
    if (options.facts !== false) {
      await measureFacts(client, projectId, teamId, run, options.complexityLog, log);
    }
  } finally {
    try {
      await client.request('DeleteProject', 'mutation', 'mutation DeleteProject($id: String!) { projectDelete(id: $id) { success } }', { id: projectId });
      run.cleanup.push('run project deleted');
    } catch (error) {
      run.cleanup.push(`run project NOT deleted: ${describe(error)}`);
    }
    run.finishedAt = new Date(now()).toISOString();
  }
  return run;
}

async function findTeam(client: LinearClient, key: string | undefined): Promise<string> {
  const data = await client.request<{ teams: { nodes: Array<{ id: string; key: string }> } }>(
    'Teams',
    'query',
    'query Teams { teams { nodes { id key } } }',
  );
  const team = key ? data.teams.nodes.find((t) => t.key === key) : data.teams.nodes[0];
  if (!team) throw new Error(key ? `no team with key ${key}` : 'the workspace has no team');
  return team.id;
}

/** Removes probe projects left by killed runs; never touches anything without the probe's prefix. */
async function sweepLeftovers(client: LinearClient, now: number, run: ProbeRun, log: (line: string) => void): Promise<void> {
  const data = await client.request<{ projects: { nodes: Array<{ id: string; name: string; createdAt: string }> } }>(
    'ProbeLeftovers',
    'query',
    `query ProbeLeftovers($prefix: String!) {
      projects(first: 50, filter: { name: { startsWith: $prefix } }) { nodes { id name createdAt } }
    }`,
    { prefix: PROJECT_PREFIX },
  );
  for (const project of data.projects.nodes) {
    if (!project.name.startsWith(PROJECT_PREFIX)) continue;
    if (now - Date.parse(project.createdAt) < SWEEP_AGE_MS) continue;
    await client.request('DeleteProject', 'mutation', 'mutation DeleteProject($id: String!) { projectDelete(id: $id) { success } }', { id: project.id });
    run.cleanup.push(`leftover project from an earlier run deleted`);
    log('deleted a leftover probe project');
  }
}

async function createProject(client: LinearClient, name: string, teamId: string): Promise<string> {
  const data = await client.request<{ projectCreate: { project: { id: string } } }>(
    'CreateProject',
    'mutation',
    'mutation CreateProject($input: ProjectCreateInput!) { projectCreate(input: $input) { project { id } } }',
    { input: { name, teamIds: [teamId] } },
  );
  return data.projectCreate.project.id;
}

async function uploadAssets(
  client: LinearClient,
  bank: Bank,
  sources: readonly string[],
  run: ProbeRun,
  log: (line: string) => void,
): Promise<AssetMap> {
  const urls = new Map<string, string>();
  for (const file of linkedAssets(bank, sources)) {
    const bytes = Uint8Array.from(readFileSync(join(bank.dir, file)));
    try {
      const { assetUrl } = await client.uploadFile({ filename: file.split('/').pop()!, contentType: contentTypeOf(file), bytes });
      urls.set(file, assetUrl);
      run.uploads.push({ file, outcome: 'uploaded' });
    } catch (error) {
      if (error instanceof LinearStoppedError) throw error;
      if (!(error instanceof LinearGraphQLError || error instanceof LinearUploadError)) throw error;
      run.uploads.push({ file, outcome: `refused: ${describe(error)}` });
    }
  }
  log(`uploaded ${urls.size} assets`);
  return { urls };
}

async function probeFixtures(
  client: LinearClient,
  projectId: string,
  fixtures: readonly BankFixture[],
  sources: readonly string[],
  assets: AssetMap,
  run: ProbeRun,
  log: (line: string) => void,
): Promise<void> {
  const created: Array<{ result: FixtureResult; id: string; returned: string | null | undefined }> = [];
  for (const [index, fixture] of fixtures.entries()) {
    const source = sources[index]!;
    const result: FixtureResult = {
      file: fixture.file,
      group: fixture.group,
      construct: fixture.construct,
      class: fixture.class,
      rule: fixture.rule,
      basis: fixture.basis,
      source,
    };
    run.fixtures.push(result);
    try {
      const document = await client.createDocument(
        { projectId },
        { title: `Sample ${index + 1} ${fixture.canary}`, content: toLinear(source, assets) },
      );
      created.push({ result, id: document.id, returned: document.content });
    } catch (error) {
      if (!(error instanceof LinearGraphQLError)) throw error;
      result.refused = describe(error);
    }
  }
  log(`created ${created.length} of ${fixtures.length} documents`);

  const firstRead = await readBack(client, created.map((c) => c.id), run);
  const rawFirst = new Map<string, string>();
  const updated: Array<{ result: FixtureResult; id: string; returned: string | null | undefined }> = [];
  for (const entry of created) {
    const document = firstRead.get(entry.id);
    if (!document) {
      entry.result.refused = 'created, but the document was not found on reading it back';
      continue;
    }
    const content = document.content ?? '';
    rawFirst.set(entry.id, content);
    entry.result.first = fromLinear(content, assets);
    entry.result.createReturnedStored = entry.returned === document.content;
    decodeInto(entry.result, document, assets, run, 'yjs');
    try {
      const after = await client.updateDocument(entry.id, { content });
      updated.push({ result: entry.result, id: entry.id, returned: after.content });
    } catch (error) {
      if (!(error instanceof LinearGraphQLError)) throw error;
      entry.result.secondRefused = describe(error);
    }
  }
  log(`wrote ${updated.length} readbacks back`);

  const secondRead = await readBack(client, updated.map((u) => u.id), run);
  for (const entry of updated) {
    const document = secondRead.get(entry.id);
    if (!document) continue;
    const content = document.content ?? '';
    entry.result.second = fromLinear(content, assets);
    entry.result.fixedPoint = content === rawFirst.get(entry.id);
    entry.result.updateReturnedStored = entry.returned === document.content;
    if (entry.result.yjs) {
      const probe: FixtureResult = { ...entry.result };
      delete probe.yjs;
      decodeInto(probe, document, assets, run, 'yjs');
      entry.result.yjsStable = probe.yjs !== undefined && JSON.stringify(probe.yjs) === JSON.stringify(entry.result.yjs);
    }
  }
}

function decodeInto(result: FixtureResult, document: ReadDocument, assets: AssetMap, run: ProbeRun, key: 'yjs'): void {
  if (run.yjsBlocked) return;
  if (typeof document.contentState !== 'string' || document.contentState === '') {
    result.yjsError = 'no content state returned';
    return;
  }
  try {
    result[key] = summarizeContentState(document.contentState, { mapString: (value) => fromLinear(value, assets) });
  } catch (error) {
    result.yjsError = `decode failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const READ_FIELDS = 'id content trashed archivedAt team { id }';

/**
 * Reads documents by id with their content and content state. When Linear no
 * longer serves `contentState` (an internal field), reads without it and
 * marks Yjs as blocked for the run.
 */
async function readBack(client: LinearClient, ids: readonly string[], run: ProbeRun): Promise<Map<string, ReadDocument>> {
  const result = new Map<string, ReadDocument>();
  for (let start = 0; start < ids.length; start += READ_PAGE_SIZE) {
    const chunk = ids.slice(start, start + READ_PAGE_SIZE);
    const read = (withState: boolean) =>
      client.request<{ documents: { nodes: ReadDocument[] } }>(
        withState ? 'ReadBack' : 'ReadBackMarkdown',
        'query',
        `query ${withState ? 'ReadBack' : 'ReadBackMarkdown'}($ids: [ID!]!, $first: Int!) {
          documents(first: $first, includeArchived: true, filter: { id: { in: $ids } }) {
            nodes { ${READ_FIELDS}${withState ? ' contentState' : ''} }
          }
        }`,
        { ids: chunk, first: chunk.length },
      );
    let data: { documents: { nodes: ReadDocument[] } };
    if (run.yjsBlocked) {
      data = await read(false);
    } else {
      try {
        data = await read(true);
      } catch (error) {
        if (!(error instanceof LinearGraphQLError) || !/contentState/i.test(error.message)) throw error;
        run.yjsBlocked = describe(error);
        data = await read(false);
      }
    }
    for (const document of data.documents.nodes) result.set(document.id, document);
  }
  return result;
}

async function measureFacts(
  client: LinearClient,
  projectId: string,
  teamId: string,
  run: ProbeRun,
  complexityLog: Map<string, number | undefined> | undefined,
  log: (line: string) => void,
): Promise<void> {
  const facts = run.facts;
  const done = run.fixtures.filter((f) => f.createReturnedStored !== undefined);
  const updatedCount = run.fixtures.filter((f) => f.updateReturnedStored !== undefined);
  facts.mutationsReturnStoredContent = {
    create: { same: done.filter((f) => f.createReturnedStored).length, different: done.filter((f) => !f.createReturnedStored).length },
    update: {
      same: updatedCount.filter((f) => f.updateReturnedStored).length,
      different: updatedCount.filter((f) => !f.updateReturnedStored).length,
    },
  };

  const scratch = await client.createDocument({ projectId }, { title: 'Limits', content: 'Short text.' });

  const titleTry = async (length: number) => attempt(() => client.updateDocument(scratch.id, { title: 'T'.repeat(length) }));
  facts.titleLength = await findLimit(titleTry, 255, 100_000);
  log(`title limit: ${JSON.stringify(facts.titleLength)}`);

  const contentTry = async (length: number) => attempt(() => client.updateDocument(scratch.id, { content: 'a'.repeat(length) }));
  facts.contentLength = await findLimit(contentTry, 200_000, 2_000_000);
  log(`content limit: ${JSON.stringify(facts.contentLength)}`);

  if (facts.contentLength.refused !== undefined) {
    const limit = facts.contentLength.accepted;
    const outcome = async (content: string) => {
      const refusal = await attempt(() => client.updateDocument(scratch.id, { content }));
      return refusal === undefined ? 'accepted' : `refused (${refusal})`;
    };
    // Each content is over the limit in one way of counting and within it in the others.
    facts.contentUnit = {
      utf16Units: await outcome('\u{1F600}'.repeat(Math.floor(limit / 2) + 1)),
      utf8Bytes: await outcome('\u00e9'.repeat(limit)),
      codePoints: await outcome('\u{1F600}'.repeat(limit + 1)),
    };
  }

  facts.uploads = [];
  for (const declaredBytes of [10 * 1024 * 1024, 10 * 1024 * 1024 + 1, 100 * 1024 * 1024]) {
    const refusal = await attempt(() =>
      client.request('FileUploadLimit', 'mutation', `mutation FileUploadLimit($size: Int!) {
        fileUpload(contentType: "application/octet-stream", filename: "large.bin", size: $size) { success uploadFile { assetUrl } }
      }`, { size: declaredBytes }),
    );
    facts.uploads.push({ declaredBytes, outcome: refusal === undefined ? 'upload target issued' : `refused (${refusal})` });
  }

  const trashedDoc = await client.createDocument({ projectId }, { title: 'Old notes', content: 'Kept for reference.' });
  await client.trashDocument(trashedDoc.id);
  const seen = async (operation: string, filter: unknown, includeArchived: boolean) => {
    const data = await client.request<{ documents: { nodes: ReadDocument[] } }>(
      operation,
      'query',
      `query ${operation}($filter: DocumentFilter, $includeArchived: Boolean!) {
        documents(first: 50, filter: $filter, includeArchived: $includeArchived) { nodes { ${READ_FIELDS} } }
      }`,
      { filter, includeArchived },
    );
    const found = data.documents.nodes.find((d) => d.id === trashedDoc.id);
    return found ? `listed (trashed: ${found.trashed}, archivedAt set: ${found.archivedAt !== null})` : 'not listed';
  };
  facts.trashed = {
    'project filter': await seen('TrashedByProject', { project: { id: { eq: projectId } } }, false),
    'project filter, includeArchived': await seen('TrashedByProjectArchived', { project: { id: { eq: projectId } } }, true),
    'id filter': await seen('TrashedById', { id: { in: [trashedDoc.id] } }, false),
    'id filter, includeArchived': await seen('TrashedByIdArchived', { id: { in: [trashedDoc.id] } }, true),
  };

  const teamData = await client.request<{ documents: { nodes: ReadDocument[] } }>(
    'TeamFilter',
    'query',
    `query TeamFilter($teamId: ID!, $id: ID!) {
      documents(first: 5, filter: { and: [{ team: { id: { eq: $teamId } } }, { id: { eq: $id } }] }) { nodes { ${READ_FIELDS} } }
    }`,
    { teamId, id: scratch.id },
  );
  facts.teamFilterIncludesProjectDocuments = teamData.documents.nodes.some((d) => d.id === scratch.id);
  const [scratchRead] = (await readBack(client, [scratch.id], run)).values();
  facts.projectDocumentHasTeam = scratchRead?.team !== null && scratchRead?.team !== undefined;

  facts.complexity = [];
  for (const first of [50, 100, 250]) {
    for (const withContent of [false, true]) {
      const operation = `CostList${withContent ? 'Content' : 'Meta'}${first}`;
      const refusal = await attempt(() =>
        client.request(operation, 'query', `query ${operation}($filter: DocumentFilter, $first: Int!) {
          documents(first: $first, filter: $filter) { nodes { id title updatedAt ${withContent ? 'content' : ''} project { id } } pageInfo { hasNextPage endCursor } }
        }`, { filter: { project: { id: { eq: projectId } } }, first }),
      );
      facts.complexity.push({ query: `documents list${withContent ? ' with content' : ''}`, first, complexity: complexityLog?.get(operation), outcome: refusal ?? 'ok' });
    }
  }
  for (const operation of ['ReadBack', 'CreateDocument', 'UpdateDocument', 'FileUpload', 'TrashDocument']) {
    if (complexityLog?.has(operation)) {
      facts.complexity.push({ query: operation, first: operation === 'ReadBack' ? READ_PAGE_SIZE : 1, complexity: complexityLog.get(operation), outcome: 'ok' });
    }
  }

  facts.rateLimitStatus = await client.rateLimitStatus();
  facts.rateLimitHeaders = Object.fromEntries(Object.keys(client.transport.lastRateLimit?.headers ?? {}).sort().map((name) => [name, describeHeader(client.transport.lastRateLimit, name)]));
}

function describeHeader(snapshot: RateLimitSnapshot | undefined, name: string): string {
  const value = snapshot?.headers[name] ?? '';
  return /reset$/.test(name) ? 'epoch milliseconds' : value;
}

/** Runs a write; returns undefined when Linear accepts it, the refusal when it refuses. */
async function attempt(write: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await write();
    return undefined;
  } catch (error) {
    if (error instanceof LinearGraphQLError) return describe(error);
    throw error;
  }
}

/**
 * Finds the largest accepted value: doubles from `start` until Linear refuses
 * or `max` is accepted, then halves the gap.
 */
export async function findLimit(refusalAt: (value: number) => Promise<string | undefined>, start: number, max: number): Promise<LimitFact> {
  let tries = 0;
  const tryValue = async (value: number) => {
    tries += 1;
    return refusalAt(value);
  };
  let low = 0;
  let high: number | undefined;
  let refusal: string | undefined;
  for (let value = start; ; value = Math.min(max, value * 2)) {
    const outcome = await tryValue(value);
    if (outcome === undefined) {
      low = value;
      if (value >= max) return { accepted: value, tries };
    } else {
      high = value;
      refusal = outcome;
      break;
    }
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const outcome = await tryValue(middle);
    if (outcome === undefined) low = middle;
    else {
      high = middle;
      refusal = outcome;
    }
  }
  return refusal === undefined ? { accepted: low, refused: high, tries } : { accepted: low, refused: high, refusal, tries };
}

function describe(error: unknown): string {
  if (error instanceof LinearGraphQLError) {
    // The message names the operation and Linear's code and text; never content.
    // Linear's request id changes on every call and says nothing about the refusal.
    return error.message.replace(/^[^:]*: /, '').replace(/ \(HTTP \d+, request [^)]*\)/, '');
  }
  return error instanceof Error ? error.message : String(error);
}

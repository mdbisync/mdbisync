// A sync run through Linear's bad minutes, against a local git remote and a
// fake Linear behind a faulty transport: a 429 with and without
// `Retry-After`, low remaining-budget headers, a server error or a reset
// connection on a write, and a write Linear rejects for one document. The
// run stops writing or leaves the failed document out, records what it
// finished, says so in its summary and exit status ("partial, will
// continue"), and the next run converges with no duplicates. Nothing the
// run prints holds document content or a credential.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../cli.ts';
import { INCOMPLETE_EXIT_CODE } from '../commands.ts';
import { type RunReport } from '../run/finish.ts';
import { INPUT_NAMES, environmentName } from '../run/inputs.ts';
import { renderStop } from '../run/stop.ts';
import { Git } from '../state/index.ts';
import { type FakeDocument, type FakeWorld, GITHUB_API, LINEAR_API, fakeFetch, fakeWorld, touch } from '../setup/test-helpers.ts';
import { type Fixture, IDENTITY, createFixture } from '../state/test-helpers.ts';
import { MERGE_RECORD_MESSAGE, PARTIAL_RECORD_MESSAGE } from './write.ts';

const CANARY = 'kx-73c0f1d2';
const CLIENT_SECRET = 'client-secret-6e1b';
const PRE_COMMIT = `repos:
  - repo: https://github.com/example/mdbisync
    rev: 0123456789abcdef0123456789abcdef01234567
    hooks:
      - id: linear-format
`;
const DOCUMENTS = 40;
const pathOf = (index: number) => `combined/part-${String(index).padStart(2, '0')}.md`;
const textOf = (index: number, words: string) => `# Part ${index}\n\n${words} ${CANARY}\n`;

const TREE: Record<string, string> = {
  'README.md': `# Repository\n\n${CANARY}\n`,
  'combined/README.md': `---\nlinear-team: Docs\nlinear-project: Handbook\n---\n\n# Handbook\n\n${CANARY}\n`,
  '.pre-commit-config.yaml': PRE_COMMIT,
  ...Object.fromEntries(Array.from({ length: DOCUMENTS }, (_, index) => [pathOf(index), textOf(index, 'First text.')])),
};

/** Linear's hourly limits, as its rate-limit headers give them. */
const LIMIT_HEADERS = {
  'x-ratelimit-requests-limit': '5000',
  'x-ratelimit-requests-remaining': '4900',
  'x-ratelimit-requests-reset': '1767225600000',
  'x-ratelimit-complexity-limit': '2000000',
  'x-ratelimit-complexity-remaining': '1990000',
  'x-ratelimit-complexity-reset': '1767225600000',
};

/** Faults the transport injects into the fake Linear's answers; GraphQL requests are counted from `arm`. */
interface Faults {
  /** Answer the `at`-th GraphQL request and the next `times - 1` with this status. */
  http?: { at: number; status: number; retryAfter?: string; times: number };
  /** Rate-limit headers added to every GraphQL answer from the `from`-th request on. */
  budget?: { from: number; headers: Record<string, string> };
  /**
   * Fail the next document write (create or update): a 500, a connection
   * reset before Linear applies it, or a reset after Linear applied it
   * (the answer is lost).
   */
  writeError?: 'server-error' | 'reset-before' | 'reset-after';
  /** Only this write operation gets `writeError`; any document write when absent. */
  writeErrorOn?: 'CreateDocument' | 'UpdateDocument';
  /** Refuse every write of this document id, as Linear does with an input it will not take. */
  rejectId?: string;
  /** Answer the `occurrence`-th request of `operation` with this status; with `ids`, only a request for exactly those ids. */
  onOperation?: { operation: string; occurrence: number; status: number; ids?: readonly string[]; code?: string };
}

interface Exchange {
  operation: string;
  status: number | 'reset';
  injected: boolean;
}

function resetError(): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
}

/** A transport in front of the fake Linear that injects `faults` and keeps a log of GraphQL exchanges. */
function faultyFetch(world: FakeWorld) {
  const inner = fakeFetch(world);
  const state = { faults: {} as Faults, armedAt: 0, count: 0, exchanges: [] as Exchange[], seen: new Map<string, number>() };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url !== `${LINEAR_API}/graphql`) return inner(input, init);
    state.count += 1;
    const position = state.count - state.armedAt;
    const { operationName, variables } = JSON.parse(String(init?.body)) as { operationName: string; variables: Record<string, unknown> };
    const log = (status: Exchange['status'], injected: boolean) => state.exchanges.push({ operation: operationName, status, injected });
    const { http, budget, writeError, writeErrorOn, rejectId, onOperation } = state.faults;
    const isWrite = operationName === 'CreateDocument' || operationName === 'UpdateDocument';
    const asked = Array.isArray(variables.ids) ? [...(variables.ids as string[])].sort() : undefined;
    const counted = onOperation?.ids === undefined || JSON.stringify(asked) === JSON.stringify([...onOperation.ids].sort());
    const occurrence = (state.seen.get(operationName) ?? 0) + (counted ? 1 : 0);
    state.seen.set(operationName, occurrence);

    if (onOperation !== undefined && counted && onOperation.operation === operationName && onOperation.occurrence === occurrence) {
      log(onOperation.status, true);
      const code = onOperation.code ?? (onOperation.status === 429 ? 'RATELIMITED' : 'INTERNAL_SERVER_ERROR');
      return new Response(JSON.stringify({ errors: [{ message: 'injected', extensions: { code } }] }), { status: onOperation.status, headers: { 'content-type': 'application/json', ...LIMIT_HEADERS } });
    }

    if (http !== undefined && position >= http.at && http.times > 0) {
      http.times -= 1;
      log(http.status, true);
      const headers: Record<string, string> = { 'content-type': 'application/json', ...LIMIT_HEADERS };
      if (http.retryAfter !== undefined) headers['retry-after'] = http.retryAfter;
      const code = http.status === 429 ? 'RATELIMITED' : 'INTERNAL_SERVER_ERROR';
      return new Response(JSON.stringify({ errors: [{ message: 'injected', extensions: { code } }] }), { status: http.status, headers });
    }
    if (isWrite && writeError !== undefined && (writeErrorOn === undefined || writeErrorOn === operationName)) {
      delete state.faults.writeError;
      if (writeError === 'server-error') {
        log(500, true);
        return new Response(JSON.stringify({ errors: [{ message: 'injected' }] }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
      if (writeError === 'reset-after') await inner(input, init);
      log('reset', true);
      throw resetError();
    }
    if (isWrite && rejectId !== undefined && (variables.id === rejectId || (variables.input as { id?: unknown } | undefined)?.id === rejectId)) {
      log(200, true);
      const body = { data: null, errors: [{ message: 'injected rejection', extensions: { code: 'INPUT_ERROR', userPresentableMessage: 'rejected' } }] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const answer = await inner(input, init);
    log(answer.status, false);
    if (budget === undefined || position < budget.from) return answer;
    const headers = new Headers(answer.headers);
    for (const [name, value] of Object.entries(budget.headers)) headers.set(name, value);
    return new Response(await answer.text(), { status: answer.status, headers });
  };
  return {
    fetch,
    /** Sets the faults; request positions count from now. */
    arm(faults: Faults) {
      state.faults = faults;
      state.armedAt = state.count;
      state.exchanges.length = 0;
      state.seen.clear();
    },
    clear() {
      state.faults = {};
    },
    get exchanges(): readonly Exchange[] {
      return state.exchanges;
    },
  };
}

describe('sync: rate limits and transport faults', () => {
  let fixture: Fixture;
  let cwd: string;
  let person: Git;
  let personDir: string;
  let world: FakeWorld;
  let transport: ReturnType<typeof faultyFetch>;
  const reportFile = () => join(fixture.root, 'report.json');
  const summaryFile = () => join(fixture.root, 'summary.md');

  beforeEach(async () => {
    fixture = await createFixture();
    await fixture.seed(TREE);
    cwd = (await fixture.clone('engine')).dir;
    personDir = join(fixture.root, 'person');
    await new Git(fixture.root).run(['clone', '--quiet', fixture.url, personDir]);
    person = new Git(personDir, {
      GIT_AUTHOR_NAME: IDENTITY.name,
      GIT_AUTHOR_EMAIL: IDENTITY.email,
      GIT_COMMITTER_NAME: IDENTITY.name,
      GIT_COMMITTER_EMAIL: IDENTITY.email,
    });
    world = fakeWorld();
    transport = faultyFetch(world);
    const initial = await cli('initial-sync', { MDBISYNC_DIRECTION: 'git-to-linear', MDBISYNC_CONFIRM: 'true' });
    assert.equal(initial.result.exitCode, 0, initial.result.stderr);
  });
  afterEach(() => fixture.cleanup());

  const env = (extra: Record<string, string>) => ({
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    MDBISYNC_LINEAR_CLIENT_ID: 'client-id',
    MDBISYNC_LINEAR_CLIENT_SECRET: CLIENT_SECRET,
    MDBISYNC_LINEAR_API_URL: LINEAR_API,
    MDBISYNC_GITHUB_TOKEN: 'gh-token',
    MDBISYNC_GITHUB_API_URL: GITHUB_API,
    MDBISYNC_REPOSITORY: 'owner/repo',
    MDBISYNC_REPORT_FILE: reportFile(),
    GITHUB_STEP_SUMMARY: summaryFile(),
    ...extra,
  });

  async function cli(command: string, extra: Record<string, string> = {}) {
    await rm(reportFile(), { force: true });
    await rm(summaryFile(), { force: true });
    const writesBefore = world.writes.length;
    const logs: string[] = [];
    const result = await runCli([command], { env: env(extra), cwd, fetch: transport.fetch, log: (entry) => logs.push(JSON.stringify(entry)) });
    const summary = await readFile(summaryFile(), 'utf8').catch(() => '');
    const report = JSON.parse(await readFile(reportFile(), 'utf8')) as RunReport;
    // I5: no content, token or secret in anything the run prints or reports.
    for (const text of [result.stdout, result.stderr, summary, JSON.stringify(report), ...logs]) {
      for (const secret of [CANARY, CLIENT_SECRET, 'fake-token', 'gh-token']) assert.ok(!text.includes(secret), `${secret} reached the output`);
    }
    return { result, report, summary, writes: world.writes.slice(writesBefore) };
  }

  const sync = () => cli('sync');

  async function commit(changes: Record<string, string>) {
    await person.run(['pull', '--quiet', '--ff-only']);
    for (const [path, content] of Object.entries(changes)) {
      await mkdir(dirname(join(personDir, path)), { recursive: true });
      await writeFile(join(personDir, path), content);
    }
    await person.run(['add', '--all']);
    await person.run(['commit', '--quiet', '-m', 'Edit']);
    await person.run(['push', '--quiet', 'origin', 'HEAD:main']);
  }

  const editAll = (count: number, words: string, extra: Record<string, string> = {}) =>
    commit({ ...Object.fromEntries(Array.from({ length: count }, (_, index) => [pathOf(index), textOf(index, words)])), ...extra });

  const show = async (spec: string) => (await fixture.remote.run(['show', spec])).stdout.toString('utf8');
  const rev = (spec: string) => fixture.remote.text(['rev-parse', spec]);
  const ids = async () => JSON.parse(await show('refs/mdbisync/ids:ids.json')) as Record<string, { id: string }>;
  const idOf = async (path: string) => (await ids())[path]?.id as string;
  const contentOf = async (path: string) => {
    const id = await idOf(path);
    return world.linear.documents.find((d) => d.id === id)?.content;
  };
  const recorded = (path: string) => show(`refs/mdbisync/linear:${path}`);
  const body = (text: string) => text.slice(text.indexOf('# '));
  const withNewPage = () => world.linear.documents.filter((d) => d.trashed !== true && d.content?.includes('A new page.') === true);

  /** A body as Linear holds it: each relative link to a synchronized file becomes the URL of that file's document. */
  function linearForm(path: string, text: string, map: Record<string, { id: string }>): string {
    return text.replace(/\]\(([^()<>\s#]+\.md)(#[^()\s]*)?\)/g, (link, target: string, fragment: string | undefined) => {
      const id = map[posix.join(posix.dirname(path), target)]?.id;
      return id === undefined ? link : `](<https://linear.app/${world.linear.urlKey}/document/${id}${fragment ?? ''}>)`;
    });
  }

  /** I1, I7, I8: every mapped document holds its file's body; one live document per title in a place. */
  async function assertConverged() {
    const map = await ids();
    const tracked = await rev('refs/heads/main');
    for (const [path, entry] of Object.entries(map)) {
      const document = world.linear.documents.find((d) => d.id === entry.id);
      assert.ok(document !== undefined && document.trashed !== true, `${path}: no live document`);
      assert.equal(document.content, linearForm(path, body(await show(`${tracked}:${path}`)), map), `${path}: content`);
    }
    const live = world.linear.documents.filter((d) => d.trashed !== true);
    const keys = live.map((d) => `${d.projectId ?? d.teamId}/${d.title}`);
    assert.equal(new Set(keys).size, keys.length, 'duplicate documents');
    assert.equal(live.length, Object.keys(map).length, 'a live document without an id');
  }

  /** After the fault is gone, the next run finishes, merges, and one more run changes nothing. */
  async function assertNextRunConverges() {
    transport.clear();
    const next = await sync();
    assert.equal(next.result.exitCode, 0, next.result.stderr);
    assert.equal(next.report.complete, true, JSON.stringify({ code: next.report.code, sync: next.report.sync }));
    assert.equal(next.report.exitStatus, 'success');
    assert.equal(await fixture.remote.text(['show', '-s', '--format=%s', 'refs/mdbisync/linear']), MERGE_RECORD_MESSAGE);
    await assertConverged();
    const before = await rev('refs/mdbisync/linear');
    const again = await sync();
    assert.equal(again.result.exitCode, 0, again.result.stderr);
    assert.deepEqual(again.writes, []);
    assert.equal(await rev('refs/mdbisync/linear'), before);
    assert.equal(again.report.resumed, false, 'a run after a complete one does not resume');
    return next.report;
  }

  function assertPartial(run: Awaited<ReturnType<typeof cli>>) {
    assert.equal(run.result.exitCode, INCOMPLETE_EXIT_CODE);
    assert.equal(run.report.exitStatus, 'warning');
    assert.match(run.result.stderr, /partial, will continue/);
    assert.match(run.summary, /partial, will continue/i);
  }

  it('L5-06: a 429 at the 30th request stops writing, records what finished, exits partial; the next run continues', async () => {
    await editAll(DOCUMENTS, 'Second text.');
    transport.arm({ http: { at: 30, status: 429, times: 1 } });
    const first = await sync();
    assertPartial(first);
    assert.equal(first.report.code, 'stopped');
    assert.equal(first.report.stoppedEarly, true);
    assert.equal(first.report.stop?.kind, 'rate-limited');
    const limited = transport.exchanges.findIndex((exchange) => exchange.status === 429);
    assert.equal(limited, 29, 'the 30th request was refused');
    assert.deepEqual(transport.exchanges.slice(limited + 1), [], 'nothing is sent after the 429');

    // What finished is recorded: an ordinary commit with the written documents' new text, the rest as before.
    const updated = first.report.sync?.updated ?? [];
    assert.ok(updated.length > 0 && updated.length < DOCUMENTS, `wrote ${updated.length}`);
    assert.equal(first.report.progressRecorded, true);
    assert.equal(await fixture.remote.text(['show', '-s', '--format=%s', 'refs/mdbisync/linear']), PARTIAL_RECORD_MESSAGE);
    for (let index = 0; index < DOCUMENTS; index += 1) {
      const path = pathOf(index);
      const expected = updated.includes(path) ? 'Second text.' : 'First text.';
      assert.ok((await recorded(path)).includes(expected), `${path}: recorded as ${expected}`);
      assert.ok((await contentOf(path))?.includes(expected), `${path}: Linear holds ${expected}`);
    }
    assert.match(first.summary, /Stopped: rate limited/);
    assert.equal(first.report.sync?.notAttempted.length, DOCUMENTS - updated.length);
    assert.equal(first.report.writesAfterLimit, 0);
    assert.equal(first.report.resumed, false);

    const next = await assertNextRunConverges();
    assert.equal(next.resumed, true, 'the next run goes on from the partial record');
  });

  it('L5-07: a short Retry-After gets one retry, then the run finishes', async () => {
    await editAll(2, 'Second text.');
    transport.arm({ http: { at: 1, status: 429, retryAfter: '1', times: 1 } });
    const run = await sync();
    assert.equal(run.result.exitCode, 0, run.result.stderr);
    assert.equal(run.report.exitStatus, 'success');
    assert.equal(run.report.complete, true);
    const refused = transport.exchanges.filter((exchange) => exchange.status === 429);
    assert.equal(refused.length, 1);
    const index = transport.exchanges.indexOf(refused[0] as Exchange);
    assert.equal(transport.exchanges[index + 1]?.operation, refused[0]?.operation, 'the same request is sent once more');
    await assertConverged();
  });

  it('L5-07: a Retry-After longer than the client waits for stops the run instead', async () => {
    await editAll(2, 'Second text.');
    transport.arm({ http: { at: 1, status: 429, retryAfter: '600', times: 1 } });
    const run = await sync();
    assertPartial(run);
    assert.equal(transport.exchanges.length, 1, 'no retry');
    assert.match(run.summary, /retry after 600 s/);
    await assertNextRunConverges();
  });

  it('L5-08: low remaining-budget headers before any write stop the run early; the summary gives the endpoint limits', async () => {
    await editAll(2, 'Second text.');
    const headers = {
      ...LIMIT_HEADERS,
      'x-ratelimit-requests-remaining': '1',
      'x-ratelimit-endpoint-name': 'documents',
      'x-ratelimit-endpoint-requests-limit': '100',
      'x-ratelimit-endpoint-requests-remaining': '1',
      'x-ratelimit-endpoint-requests-reset': '1767225600000',
    };
    transport.arm({ budget: { from: 1, headers } });
    const run = await sync();
    assertPartial(run);
    assert.deepEqual(run.writes, [], 'nothing is written');
    assert.equal(run.report.stoppedEarly, true);
    assert.equal(run.report.stop?.kind, 'budget-low');
    assert.equal(transport.exchanges.length, 1, 'no request after the low answer');
    for (const [name, value] of Object.entries(headers)) {
      assert.ok(run.summary.includes(`| ${name} | ${value} |`), `${name} in the summary`);
      assert.equal(run.report.stop?.limits?.[name], value, `${name} in the report`);
    }
    assert.equal(run.report.endpointLimitHeadersPresent, true);
    assert.equal(run.report.writesAfterLimit, 0);
    await assertNextRunConverges();
  });

  it('L5-08: a budget that runs low while writing stops after the answer that said so; the summary gives the endpoint limits', async () => {
    await editAll(DOCUMENTS, 'Second text.');
    const headers = {
      ...LIMIT_HEADERS,
      'x-ratelimit-endpoint-name': 'documentUpdate',
      'x-ratelimit-endpoint-requests-limit': '30',
      'x-ratelimit-endpoint-requests-remaining': '2',
      'x-ratelimit-endpoint-requests-reset': '1767225600000',
    };
    transport.arm({ budget: { from: 20, headers } });
    const run = await sync();
    assertPartial(run);
    assert.equal(transport.exchanges.length, 20, 'no request after the low answer');
    const updated = run.report.sync?.updated ?? [];
    assert.ok(updated.length > 0 && updated.length < DOCUMENTS);
    for (const path of updated) assert.ok((await recorded(path)).includes('Second text.'), `${path}: recorded`);
    assert.ok(run.summary.includes('| x-ratelimit-endpoint-requests-remaining | 2 |'));
    assert.ok(run.summary.includes('| x-ratelimit-endpoint-requests-limit | 30 |'));
    assert.equal(run.report.endpointLimitHeadersPresent, true);
    await assertNextRunConverges();
  });

  for (const variant of ['server-error', 'reset-before', 'reset-after'] as const) {
    it(`L5-09: a ${variant} on an update leaves its document unrecorded; the others are written; the next run converges`, async () => {
      await editAll(3, 'Second text.');
      transport.arm({ writeError: variant });
      const run = await sync();
      assertPartial(run);
      assert.equal(run.report.code, 'write-failed');
      const failed = run.report.sync?.failed ?? [];
      assert.deepEqual(failed.map((entry) => entry.path), [pathOf(0)]);
      assert.deepEqual(run.report.sync?.updated, [pathOf(1), pathOf(2)]);
      // I2: the failed document is not recorded as written, whatever Linear did with it.
      assert.ok((await recorded(pathOf(0))).includes('First text.'));
      for (const path of [pathOf(1), pathOf(2)]) assert.ok((await recorded(path)).includes('Second text.'));
      assert.equal((await contentOf(pathOf(0)))?.includes('Second text.'), variant === 'reset-after');
      assert.ok(run.summary.includes(pathOf(0)), 'the summary names the document');
      assert.equal(run.report.failedWriteRecorded, false);
      assert.equal(run.report.rejectedDocumentNamed, false, 'a server error or a lost request is not a rejection');
      assert.equal(run.report.endpointLimitHeadersPresent, false);
      await assertNextRunConverges();
    });

    it(`L5-09: a ${variant} on a create records no id; the next run creates or adopts it once`, async () => {
      const path = 'combined/new.md';
      await commit({ [path]: `# New\n\nA new page. ${CANARY}\n` });
      transport.arm({ writeError: variant });
      const run = await sync();
      assertPartial(run);
      assert.deepEqual(run.report.sync?.failed.map((entry) => entry.path), [path]);
      assert.equal((await ids())[path], undefined, 'no id recorded');
      assert.equal((await fixture.remote.run(['cat-file', '-e', `refs/mdbisync/linear:${path}`], { okCodes: [0, 128] })).code, 128);
      assert.equal(withNewPage().length, variant === 'reset-after' ? 1 : 0);
      await assertNextRunConverges();
      assert.equal(withNewPage().length, 1, 'created once');
    });
  }

  it('L5-10: a document Linear rejects is named; the others are written; the run exits partial', async () => {
    await editAll(3, 'Second text.');
    transport.arm({ rejectId: await idOf(pathOf(1)) });
    const run = await sync();
    assertPartial(run);
    assert.equal(run.report.code, 'write-failed');
    assert.deepEqual(run.report.sync?.updated, [pathOf(0), pathOf(2)]);
    assert.equal(run.report.writtenCount, 2);
    assert.deepEqual(run.report.sync?.failed.map((entry) => entry.path), [pathOf(1)]);
    assert.match(run.report.sync?.failed[0]?.error ?? '', /INPUT_ERROR/);
    assert.ok(run.summary.includes(`| ${pathOf(1)} | UpdateDocument |`), 'the summary names the rejected document');
    assert.ok((await recorded(pathOf(1))).includes('First text.'));
    assert.equal(run.report.writtenDocuments, 2);
    assert.equal(run.report.rejectedDocumentNamed, true);
    assert.equal(run.report.failedWriteRecorded, false);
    await assertNextRunConverges();
  });

  it('the action ends a partial run with a warning, not a failure, and gives the limits in the job summary', async () => {
    await editAll(2, 'Second text.');
    // The action's own process, with Linear answering every GraphQL request with a 429.
    const injection = join(fixture.root, 'rate-limited-fetch.mjs');
    const helpers = new URL('../setup/test-helpers.ts', import.meta.url).href;
    await writeFile(injection, `
      import { fakeFetch, fakeWorld } from ${JSON.stringify(helpers)};
      const original = fakeFetch(fakeWorld());
      globalThis.fetch = async (input, init) => {
        if (String(input).endsWith('/graphql')) {
          return new Response(JSON.stringify({ errors: [{ message: 'limited', extensions: { code: 'RATELIMITED' } }] }), {
            status: 429,
            headers: ${JSON.stringify(LIMIT_HEADERS)},
          });
        }
        return original(input, init);
      };
    `);
    const engineEnv: Record<string, string> = env({});
    const actionEnv = Object.fromEntries(INPUT_NAMES.map((name) => [`INPUT_${name.toUpperCase()}`, engineEnv[environmentName(name)] ?? '']));
    const summary = join(fixture.root, 'action-summary.md');
    await writeFile(summary, '');
    const child = spawnSync(process.execPath, ['--import', injection, fileURLToPath(new URL('../action/main.ts', import.meta.url))], {
      cwd,
      env: { ...engineEnv, ...actionEnv, INPUT_OPERATION: 'sync', GITHUB_WORKSPACE: cwd, GITHUB_OUTPUT: '', GITHUB_STATE: '', GITHUB_STEP_SUMMARY: summary },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(child.status, 0, `${child.stdout}${child.stderr}`);
    assert.match(child.stdout, /^::warning::sync: partial, will continue \(stopped\)$/m);
    assert.doesNotMatch(child.stdout, /::error::/);
    const written = await readFile(summary, 'utf8');
    assert.match(written, /partial, will continue/);
    assert.ok(written.includes('| x-ratelimit-requests-limit | 5000 |'));
    for (const secret of [CANARY, CLIENT_SECRET, 'fake-token', 'gh-token']) assert.ok(!`${child.stdout}${child.stderr}${written}`.includes(secret), secret);
  });

  it('a 429 while capture reads Linear stops the run before any write; the next run converges', async () => {
    await editAll(1, 'Second text.', { 'combined/new.md': `# New\n\nA new page. ${CANARY}\n` });
    const before = await rev('refs/mdbisync/linear');
    transport.arm({ onOperation: { operation: 'ListDocuments', occurrence: 1, status: 429 } });
    const run = await sync();
    assertPartial(run);
    assert.equal(run.report.stop?.kind, 'rate-limited');
    assert.ok(run.summary.includes('| x-ratelimit-requests-limit | 5000 |'), 'the capture stop gives the limits');
    assert.deepEqual(run.writes, []);
    assert.equal(await rev('refs/mdbisync/linear'), before);
    await assertNextRunConverges();
  });

  it('a refusal while capture reads Linear fails the run: it would come back on every run', async () => {
    await editAll(1, 'Second text.');
    transport.arm({ onOperation: { operation: 'ListDocuments', occurrence: 1, status: 200, code: 'FORBIDDEN' } });
    const writesBefore = world.writes.length;
    await assert.rejects(runCli(['sync'], { env: env({}), cwd, fetch: transport.fetch, log: () => {} }), /ListDocuments: Linear error FORBIDDEN/);
    assert.deepEqual(world.writes.slice(writesBefore), [], 'nothing written');
  });

  it('a run goes on from a partial record also when its capture put a commit on top', async () => {
    await editAll(10, 'Second text.');
    transport.arm({ onOperation: { operation: 'UpdateDocument', occurrence: 4, status: 429 } });
    const first = await sync();
    assertPartial(first);
    assert.equal(first.report.sync?.record?.kind, 'ordinary', 'a partial record');
    // A person edits a document the run did not touch, so the next capture commits before the write step.
    const untouched = await idOf(pathOf(20));
    const document = world.linear.documents.find((d) => d.id === untouched) as FakeDocument;
    document.content = `${document.content ?? ''}\nAdded in Linear.\n`;
    touch(document);
    transport.clear();
    const next = await sync();
    assert.equal(next.result.exitCode, 0, next.result.stderr);
    const subjects = (await fixture.remote.text(['log', '--format=%s', 'refs/mdbisync/linear'])).split('\n');
    assert.ok(subjects.indexOf('Capture Linear changes') < subjects.indexOf(PARTIAL_RECORD_MESSAGE), 'capture committed on top of the partial record');
    assert.equal(next.report.resumed, true);
  });

  it('a 500 while capture reads Linear ends the run partial with nothing written; the next run converges', async () => {
    await editAll(1, 'Second text.', { 'combined/new.md': `# New\n\nA new page. ${CANARY}\n` });
    const before = await rev('refs/mdbisync/linear');
    transport.arm({ onOperation: { operation: 'ListDocuments', occurrence: 1, status: 500 } });
    const run = await sync();
    assertPartial(run);
    assert.equal(run.report.code, 'linear-failed');
    assert.match(run.summary, /Capture partial, will continue: Linear failed ListDocuments \(LinearGraphQLError INTERNAL_SERVER_ERROR HTTP 500\)/);
    assert.deepEqual(run.writes, []);
    assert.equal(await rev('refs/mdbisync/linear'), before);
    await assertNextRunConverges();
  });

  it("a 500 on the write step's listing of its targets writes nothing; the next run converges", async () => {
    await editAll(1, 'Second text.', { 'combined/new.md': `# New\n\nA new page. ${CANARY}\n` });
    transport.arm({ onOperation: { operation: 'ListDocuments', occurrence: 2, status: 500 } });
    const run = await sync();
    assertPartial(run);
    assert.equal(run.report.code, 'write-failed');
    assert.deepEqual(run.writes, []);
    assert.equal(withNewPage().length, 0);
    await assertNextRunConverges();
    assert.equal(withNewPage().length, 1);
  });

  /** The id in each Linear document URL in `path`'s document. */
  async function linkedIds(path: string): Promise<string[]> {
    return [...((await contentOf(path)) ?? '').matchAll(/linear\.app\/[^/]+\/document\/([0-9a-f-]+)/g)].map((match) => match[1] as string);
  }

  for (const [fault, arm] of [
    ['the create fails', async () => transport.arm({ writeError: 'server-error', writeErrorOn: 'CreateDocument' })],
    ["the create's answer is lost after Linear applied it", async () => transport.arm({ writeError: 'reset-after', writeErrorOn: 'CreateDocument' })],
  ] as const) {
    it(`when ${fault}, an edit that links to the new document keeps a link that the next run's document answers`, async () => {
      await editAll(0, '', {
        [pathOf(0)]: textOf(0, 'See [the new page](new.md).'),
        'combined/new.md': `# New\n\nA new page. ${CANARY}\n`,
      });
      await arm();
      const run = await sync();
      assertPartial(run);
      assert.deepEqual(run.report.sync?.failed.map((entry) => entry.path), ['combined/new.md']);
      assert.deepEqual(run.report.sync?.updated, [pathOf(0)]);
      const [written] = await linkedIds(pathOf(0));
      assert.ok(written !== undefined, 'the edit links to a document id');

      await assertNextRunConverges();
      const target = await idOf('combined/new.md');
      assert.equal(target, written, 'the new document got the id the edit already links to');
      assert.deepEqual(await linkedIds(pathOf(0)), [target]);
      assert.equal(withNewPage().length, 1);
    });
  }

  /** Run 1: the create of `new.md` lands in Linear but its answer is lost, while `part-00.md` is written with a link to it. */
  async function createWithLostAnswer(): Promise<string> {
    await editAll(0, '', {
      [pathOf(0)]: textOf(0, 'See [the new page](new.md).'),
      'combined/new.md': `# New\n\nA new page. ${CANARY}\n`,
    });
    transport.arm({ writeError: 'reset-after', writeErrorOn: 'CreateDocument' });
    assertPartial(await sync());
    transport.clear();
    const [created] = withNewPage();
    assert.ok(created !== undefined);
    assert.deepEqual(await linkedIds(pathOf(0)), [created.id]);
    return created.id;
  }

  it('the document with the reserved id takes its path over an older one with the same title', async () => {
    const created = await createWithLostAnswer();
    const original = world.linear.documents.find((d) => d.id === created) as (typeof world.linear.documents)[number];
    world.linear.documents.push({ ...original, id: 'older-same-title', content: 'An older page.', createdAt: '2025-01-01T00:00:00.000Z' });
    const next = await sync();
    assert.equal(next.result.exitCode, 0, next.result.stderr);
    assert.equal(await idOf('combined/new.md'), created, 'the document the link names keeps the reserved path');
    assert.deepEqual(await linkedIds(pathOf(0)), [created]);
    // The older page is a person's own document: it is taken in under a path of its own, never in place of the new one.
    const map = await ids();
    const older = Object.entries(map).find(([, entry]) => entry.id === 'older-same-title');
    assert.ok(older !== undefined && older[0] !== 'combined/new.md', JSON.stringify(older));
  });

  it('when the reserved ids cannot be checked, only the new documents that would use one wait', async () => {
    await commit({ 'combined/new.md': `# New\n\nA new page. ${CANARY}\n` });
    transport.arm({ writeError: 'server-error', writeErrorOn: 'CreateDocument' });
    assertPartial(await sync());
    const reservedId = JSON.parse(await show('refs/mdbisync/ids:reserved-ids.json'))['combined/new.md'] as string;
    await commit({ 'combined/other.md': `# Other\n\nAnother page. ${CANARY}\n` });
    transport.arm({ onOperation: { operation: 'GetDocuments', occurrence: 1, status: 502, ids: [reservedId] } });
    const run = await sync();
    assertPartial(run);
    assert.deepEqual(run.report.sync?.created, ['combined/other.md']);
    assert.deepEqual(run.report.sync?.failed.map((entry) => [entry.path, entry.operation]), [['combined/new.md', 'GetDocuments']]);
    assert.equal(run.report.rejectedDocumentNamed, false, 'a failed read is not a rejection');
    await assertNextRunConverges();
    assert.equal(await idOf('combined/new.md'), reservedId);
  });

  it('a reserved id that Linear already gives a trashed document is not used again; the run is not stuck', async () => {
    const created = await createWithLostAnswer();
    (world.linear.documents.find((d) => d.id === created) as { trashed?: boolean }).trashed = true;
    const next = await sync();
    assert.equal(next.result.exitCode, 0, next.result.stderr);
    assert.equal(next.report.complete, true);
    const id = await idOf('combined/new.md');
    assert.notEqual(id, created, 'a new id, since Linear refuses a second document with the trashed one');
    assert.equal(withNewPage().length, 1);
    // Known limit: the document written in the first run keeps its link to the trashed document. Rewriting it needs
    // the sync to tell a link it wrote from a person's edit, which it cannot yet.
    assert.deepEqual(await linkedIds(pathOf(0)), [created]);
  });

  it('a 500 on the read before writing leaves the batch unwritten and unrecorded; the next run converges', async () => {
    await editAll(3, 'Second text.');
    // The write step's re-read asks for exactly the edited documents.
    const edited = await Promise.all([0, 1, 2].map((index) => idOf(pathOf(index))));
    transport.arm({ onOperation: { operation: 'GetDocuments', occurrence: 1, status: 500, ids: edited } });
    const run = await sync();
    assertPartial(run);
    assert.deepEqual(run.writes, []);
    assert.deepEqual(run.report.sync?.failed.map((entry) => entry.path).sort(), [pathOf(0), pathOf(1), pathOf(2)]);
    assert.equal(run.report.rejectedDocumentNamed, false);
    await assertNextRunConverges();
  });
});

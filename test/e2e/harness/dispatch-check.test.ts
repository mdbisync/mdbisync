import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { dispatchCheck, documentedScript, runScript, SCRIPT_PAGE, scriptFor } from './dispatch-check.ts';
import { REPO_ROOT } from './engine.ts';
import { acquireLock } from './locks.ts';
import { EnvBlockedError } from './results.ts';

const OWNER = 'octo-org';
const REPO = 'notes-sandbox';
const REPO_PATH = `/repos/${OWNER}/${REPO}`;
const page = readFileSync(join(REPO_ROOT, SCRIPT_PAGE), 'utf8');
const realCurl = spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim();

describe('the published dispatch script', () => {
  it('is the page\'s first sh block under "A dispatch script", with one repository placeholder', () => {
    const script = documentedScript(page);
    assert.ok(script.startsWith('#!/bin/sh\n'));
    assert.match(script, /actions\/workflows\/mdbisync\.yml\/dispatches/);
    const filled = scriptFor(script, OWNER, REPO);
    // The one edit the page asks for, and nothing else.
    assert.equal(filled, script.replace('<owner>/<repository>', `${OWNER}/${REPO}`));
    assert.ok(filled.includes(`repository='${OWNER}/${REPO}'`));
  });

  it('refuses a page without the section, a script without one placeholder and names that are not plain', () => {
    assert.throws(() => documentedScript(page.replace('## A dispatch script', '## Another heading')), /no "A dispatch script" section/);
    assert.throws(() => documentedScript('## A dispatch script\n\n```sh\necho hi\n```\n'), /not the first sh block/);
    const script = documentedScript(page);
    assert.throws(() => scriptFor(script.replace('<owner>/<repository>', 'x/y'), OWNER, REPO), /exactly once/);
    assert.throws(() => scriptFor(script, "octo'org", REPO), /not plain/);
    assert.throws(() => scriptFor(script, OWNER, 'notes;rm'), /not plain/);
  });
});

interface Minted { token: string; permissions: Record<string, string>; revoked: boolean }
interface Seen { method: string; path: string; headers: IncomingMessage['headers']; body: string }

/** A local stand-in for the parts of GitHub's API the check uses. */
class MockGitHub {
  readonly minted: Minted[] = [];
  readonly seen: Seen[] = [];
  readonly cancelled: number[] = [];
  runs: Array<Record<string, unknown>> = [{ id: 100, head_branch: 'main', actor: { login: 'sync-app[bot]' }, created_at: '2026-01-01T00:00:00Z' }];
  state = 'active';
  /** Whether the default branch carries the workflow file. */
  onMain = true;
  /** Whether an accepted dispatch shows up as a run. */
  startsRuns = true;
  /** Answer 204 to every dispatch, whatever the token may do. */
  acceptsAny = false;
  /** Listings after a dispatch that do not show its run yet, as GitHub's lag. */
  lagListings = 0;
  /** Listings after a dispatch that fail with HTTP 502. */
  failListings = 0;
  /** Runs someone else starts with each accepted dispatch. */
  alsoStarts = 0;
  /** Drop the connection of a dispatch by a token without Actions write, so the script hears no answer. */
  dropDenied = false;
  /** Whether the App is installed on the repository. */
  installed = true;
  /** When the last accepted dispatch and each cancel arrived. */
  dispatchedAt = 0;
  readonly cancelledAt: number[] = [];
  /** The answer to a cancel, 202 when it works. */
  cancelStatus = 202;
  /** Runs dispatched so far, and listings since the last dispatch. */
  #dispatched = 0;
  #listings = 0;
  url = '';
  readonly #server = createServer((request, response) => { void this.#handle(request, response); });

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  fetch: typeof fetch = (input, init) => fetch(String(input).replace('https://api.github.com', this.url), init);

  #token(request: IncomingMessage): Minted | undefined {
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    return this.minted.find((entry) => entry.token === bearer && !entry.revoked);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const path = request.url ?? '';
    this.seen.push({ method: request.method ?? '', path, headers: request.headers, body });
    const send = (status: number, value?: unknown) => {
      response.writeHead(status, value === undefined ? {} : { 'content-type': 'application/json' });
      response.end(value === undefined ? undefined : JSON.stringify(value));
    };
    const route = `${request.method} ${path}`;
    if (route === `GET ${REPO_PATH}/installation`) return this.installed ? send(200, { id: 7, app_slug: 'sync-app' }) : send(404, { message: 'Not Found' });
    if (route === 'POST /app/installations/7/access_tokens') {
      const asked = JSON.parse(body) as { permissions: Record<string, string> };
      const token = `ghs_${randomBytes(18).toString('hex')}`;
      this.minted.push({ token, permissions: asked.permissions, revoked: false });
      return send(201, { token });
    }
    const token = this.#token(request);
    if (token === undefined) return send(401, { message: 'Bad credentials' });
    if (route === 'DELETE /installation/token') { token.revoked = true; return send(204); }
    if (route === `GET ${REPO_PATH}/actions/workflows/mdbisync.yml`) return send(200, { state: this.state });
    if (route === `GET ${REPO_PATH}/contents/.github/workflows/mdbisync.yml?ref=main` && token.permissions.contents === 'read') {
      return this.onMain ? send(200, { encoding: 'base64', content: Buffer.from('name: mdbisync\n').toString('base64') }) : send(404, { message: 'Not Found' });
    }
    if (route === `GET ${REPO_PATH}/actions/workflows/mdbisync.yml/runs?event=workflow_dispatch&per_page=50`) {
      if (this.#dispatched > 0) {
        this.#listings += 1;
        if (this.#listings <= this.failListings) return send(502, { message: 'Bad Gateway' });
        if (this.#listings <= this.failListings + this.lagListings) return send(200, { workflow_runs: [...this.runs].slice(0, this.runs.length - this.#dispatched).reverse() });
      }
      return send(200, { workflow_runs: [...this.runs].reverse() });
    }
    if (route === `POST ${REPO_PATH}/actions/workflows/mdbisync.yml/dispatches`) {
      if (token.permissions.actions !== 'write' && this.dropDenied) { request.socket.destroy(); return; }
      if (token.permissions.actions !== 'write' && !this.acceptsAny) return send(403, { message: 'Resource not accessible by integration' });
      this.dispatchedAt = Date.now();
      if (this.startsRuns) {
        this.#dispatched += 1;
        this.#listings = 0;
        const id = Number(this.runs.at(-1)?.id ?? 100) + 1;
        this.runs.push({ id, head_branch: JSON.parse(body).ref, actor: { login: 'sync-app[bot]' }, created_at: new Date().toISOString(), html_url: `https://github.com/${OWNER}/${REPO}/actions/runs/${id}` });
        for (let other = 1; other <= this.alsoStarts; other += 1) {
          this.#dispatched += 1;
          this.runs.push({ id: id + other, head_branch: 'main', actor: { login: 'sync-app[bot]' }, created_at: new Date().toISOString() });
        }
      }
      return send(204);
    }
    const cancel = new RegExp(`^POST ${REPO_PATH}/actions/runs/(\\d+)/cancel$`).exec(route);
    if (cancel !== null && token.permissions.actions === 'write') {
      if (this.cancelStatus !== 202) return send(this.cancelStatus, { message: 'refused' });
      this.cancelled.push(Number(cancel[1]));
      this.cancelledAt.push(Date.now());
      return send(202, {});
    }
    send(404, { message: 'Not Found' });
  }
}

describe('dispatch-check against a mock endpoint', { skip: realCurl === '' ? 'curl is not installed' : false }, () => {
  let bin: string;
  let stateDir: string;
  let privateKey: string;
  before(() => {
    bin = mkdtempSync(join(tmpdir(), 'dispatch-check-bin-'));
    stateDir = mkdtempSync(join(tmpdir(), 'dispatch-check-state-'));
    privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  });
  after(() => {
    rmSync(bin, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  /** A `curl` first on PATH that sends the script's real curl to the mock instead of api.github.com. */
  const pathTo = (mock: MockGitHub) => {
    writeFileSync(join(bin, 'curl'), [
      '#!/bin/sh',
      'for arg do',
      '  shift',
      `  case $arg in https://api.github.com/*) arg="${mock.url}\${arg#https://api.github.com}" ;; esac`,
      '  set -- "$@" "$arg"',
      'done',
      `exec '${realCurl}' "$@"`,
      '',
    ].join('\n'), { mode: 0o700 });
    return `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`;
  };

  const check = async (mock: MockGitHub, options: { keepRun?: boolean; lookForMs?: number } = {}) => {
    const lines: string[] = [];
    const report = await dispatchCheck({
      config: { owner: OWNER, repo: REPO, sandboxUrl: `https://github.com/${OWNER}/${REPO}`, githubApp: { clientId: 'Iv1.test', privateKey }, githubAppMissing: [] },
      stateDir, fetch: mock.fetch, env: { PATH: pathTo(mock) }, log: (line) => lines.push(line),
      ...(options.keepRun === undefined ? {} : { keepRun: options.keepRun }),
      timing: { lookForMs: options.lookForMs ?? 5_000, pollMs: 50 },
    });
    return { report, lines };
  };

  const withMock = async (use: (mock: MockGitHub) => Promise<void>) => {
    const mock = new MockGitHub();
    await mock.start();
    try { await use(mock); } finally { await mock.stop(); }
  };

  it('records the 403 and the dispatched run, cancels it and revokes both tokens', () => withMock(async (mock) => {
    const { report, lines } = await check(mock);
    assert.equal(report.ok, true);
    assert.deepEqual(mock.minted.map((entry) => entry.permissions), [{ actions: 'read', contents: 'read' }, { actions: 'write' }]);
    assert.deepEqual({ exitCode: report.denied.exitCode, httpStatus: report.denied.httpStatus, stderr: report.denied.stderr },
      { exitCode: 1, httpStatus: '403', stderr: 'mdbisync dispatch failed: HTTP 403\n' });
    assert.deepEqual({ exitCode: report.allowed.exitCode, httpStatus: report.allowed.httpStatus, stdout: report.allowed.stdout, stderr: report.allowed.stderr, signal: report.allowed.signal },
      { exitCode: 0, httpStatus: '2xx', stdout: '', stderr: '', signal: null });
    assert.deepEqual(report.runs.map((run) => [run.id, run.after]), [[101, 'cancelled']]);
    assert.ok((report.runs[0]?.appearedAfterMs ?? Infinity) < 5_000);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(mock.cancelled, [101]);
    assert.equal(report.tokensRevoked, true);
    assert.ok(mock.minted.every((entry) => entry.revoked));
    assert.match(report.scriptSha256, /^[0-9a-f]{64}$/);

    // The script's own request: the token alone in the header (its file ends in a newline), the page's headers and body.
    const dispatches = mock.seen.filter((entry) => entry.path.endsWith('/dispatches'));
    assert.equal(dispatches.length, 2);
    for (const [index, dispatch] of dispatches.entries()) {
      assert.equal(dispatch.headers.authorization, `Bearer ${mock.minted[index]?.token}`);
      assert.equal(dispatch.headers.accept, 'application/vnd.github+json');
      assert.equal(dispatch.headers['x-github-api-version'], '2022-11-28');
      assert.equal(dispatch.body, '{"ref":"main"}');
    }
    // No token in the record or the log.
    const out = JSON.stringify(report) + lines.join('\n');
    for (const { token } of mock.minted) assert.ok(!out.includes(token));
  }));

  it('leaves the run alone with --keep-run', () => withMock(async (mock) => {
    const { report } = await check(mock, { keepRun: true });
    assert.equal(report.ok, true);
    assert.deepEqual(report.runs.map((run) => run.after), ['kept']);
    assert.deepEqual(mock.cancelled, []);
  }));

  it('fails when the accepted dispatch shows no run', () => withMock(async (mock) => {
    mock.startsRuns = false;
    const { report } = await check(mock, { lookForMs: 300 });
    assert.equal(report.denied.ok, true);
    assert.equal(report.allowed.exitCode, 0);
    assert.deepEqual(report.runs, []);
    assert.equal(report.ok, false);
    assert.ok(mock.minted.every((entry) => entry.revoked));
  }));

  it('fails when the token without Actions write is let through, and cancels both runs even when GitHub lists them late', () => withMock(async (mock) => {
    mock.acceptsAny = true;
    mock.lagListings = 3;
    const { report } = await check(mock);
    assert.equal(report.denied.exitCode, 0);
    assert.equal(report.denied.ok, false);
    assert.deepEqual(report.runs.map((run) => [run.id, run.after]), [[101, 'cancelled'], [102, 'cancelled']]);
    assert.equal(report.allowed.ok, false);
    assert.equal(report.ok, false);
  }));

  it('fails, naming every run, when another run of the workflow by the App appears in the window', () => withMock(async (mock) => {
    mock.alsoStarts = 1;
    const { report } = await check(mock);
    assert.deepEqual(report.runs.map((run) => run.id), [101, 102]);
    assert.equal(report.allowed.ok, false);
    assert.equal(report.ok, false);
  }));

  it('records errors after the dispatch and still cancels the run and prints the record', () => withMock(async (mock) => {
    mock.failListings = 2;
    const first = await check(mock);
    assert.deepEqual(first.report.runs.map((run) => [run.id, run.after]), [[101, 'cancelled']]);
    assert.equal(first.report.errors.length, 2);
    assert.match(first.report.errors[0] ?? '', /^listing runs: GET .*HTTP 502$/);
    assert.equal(first.report.ok, false);

    mock.failListings = 0;
    mock.cancelStatus = 403;
    const second = await check(mock);
    assert.deepEqual(second.report.runs.map((run) => run.id), [102]);
    assert.match(second.report.runs[0]?.after ?? '', /^not cancelled: POST .*HTTP 403$/);
    assert.equal(second.report.ok, false);
    assert.ok(mock.minted.every((entry) => entry.revoked));
  }));

  it('cancels a run as soon as it is seen while it still looks for one a lost answer may have started', () => withMock(async (mock) => {
    mock.dropDenied = true;
    const started = Date.now();
    const { report } = await check(mock, { lookForMs: 1_500 });
    const finished = Date.now();
    assert.equal(report.denied.httpStatus, '000');
    assert.equal(report.denied.ok, false);
    assert.deepEqual(report.runs.map((run) => [run.id, run.after]), [[101, 'cancelled']]);
    // It kept looking for the whole window, but cancelled the run long before the window ended.
    assert.ok(finished - started >= 1_500);
    assert.ok((mock.cancelledAt[0] as number) - mock.dispatchedAt < 1_000);
  }));

  it('is env-blocked, not failed, when a call before the first dispatch fails', () => withMock(async (mock) => {
    mock.installed = false;
    await assert.rejects(check(mock), (error) => error instanceof EnvBlockedError && /^before any dispatch: GET .*HTTP 404; nothing was dispatched$/.test(error.message));
    assert.equal(mock.minted.length, 0);
    assert.equal(mock.seen.filter((entry) => entry.path.endsWith('/dispatches')).length, 0);
  }));

  it('runs one check at a time on a host', () => withMock(async (mock) => {
    const held = await acquireLock('dispatch-check', { stateDir, runId: 'abc123', timeoutMs: 0 });
    try {
      await assert.rejects(check(mock), (error) => error instanceof EnvBlockedError && /another dispatch check is running/.test(error.message));
      assert.equal(mock.minted.length, 0);
    } finally { held.release(); }
  }));

  it('dispatches nothing while the workflow is disabled, and still revokes the tokens', () => withMock(async (mock) => {
    mock.state = 'disabled_inactivity';
    await assert.rejects(check(mock), (error) => error instanceof EnvBlockedError && /disabled_inactivity; nothing was dispatched/.test(error.message));
    assert.equal(mock.seen.filter((entry) => entry.path.endsWith('/dispatches')).length, 0);
    assert.equal(mock.minted.length, 2);
    assert.ok(mock.minted.every((entry) => entry.revoked));
  }));

  it('dispatches nothing when main lacks the workflow file', () => withMock(async (mock) => {
    mock.onMain = false;
    await assert.rejects(check(mock), (error) => error instanceof EnvBlockedError && /main has no \.github\/workflows\/mdbisync\.yml/.test(error.message));
    assert.equal(mock.seen.filter((entry) => entry.path.endsWith('/dispatches')).length, 0);
    assert.ok(mock.minted.every((entry) => entry.revoked));
  }));

  it('gives the script the token at the documented path through a pipe, never on disk, and masks it in its output', () => withMock(async (mock) => {
    const token = `ghs_${randomBytes(18).toString('hex')}`;
    // A script that looks where a token could be: the documented path holds it, no file in its folder does.
    const probe = [
      '#!/bin/sh',
      'token=$(tr -d \'[:space:]\' < "$CREDENTIALS_DIRECTORY/dispatch-token")',
      'printf "%s|%s|%s\\n" "$HOME" "$CREDENTIALS_DIRECTORY" "$token"',
      'grep -rlF "$token" "$HOME" >&2 || echo "not on disk" >&2',
      'exit 3',
      '',
    ].join('\n');
    const result = await runScript(probe, token, { PATH: pathTo(mock) });
    assert.equal(result.exitCode, 3);
    assert.equal(result.httpStatus, null);
    const [home, credentials, shown] = result.stdout.trim().split('|') as [string, string, string];
    assert.equal(shown, '[masked]');
    assert.ok(credentials.startsWith(`${home}/`));
    assert.equal(result.stderr, 'not on disk\n');
    assert.equal(spawnSync('test', ['-e', home]).status, 1);
  }));

  it('reports a script that stops before reading its token', async () => {
    const result = await runScript('#!/bin/sh\nexit 4\n', `ghs_${randomBytes(18).toString('hex')}`, { PATH: process.env.PATH ?? '/usr/bin:/bin' });
    assert.equal(result.exitCode, 4);
  });
});

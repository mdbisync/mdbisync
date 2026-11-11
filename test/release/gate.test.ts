import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { parse } from 'yaml';
import { releaseGate } from '../../src/release/gate.ts';
import { validateVersion } from '../../src/release/package.ts';

const repo = 'example/project';
const source = 'a'.repeat(40);
const later = 'b'.repeat(40);
const older = 'c'.repeat(40);

interface Reply { status?: number; body: unknown; link?: string }
type Routes = Record<string, Reply>;

// A clean repository: a green gate status, no open alerts, and CodeQL analyses at the source commit.
function cleanRoutes(): Routes {
  return {
    [`/repos/${repo}/commits/${source}/statuses?per_page=100`]: { body: [
      { context: 'ci', state: 'failure' },
      { context: 'security-gate', state: 'success', description: 'No open findings' },
      { context: 'security-gate', state: 'failure', description: 'An older run' },
    ] },
    [`/repos/${repo}/code-scanning/alerts?state=open&ref=refs/heads/main&per_page=100`]: { body: [
      { number: 7, rule: { severity: 'warning', security_severity_level: 'low' } },
      { number: 8, rule: { severity: 'note', security_severity_level: null } },
    ] },
    [`/repos/${repo}/secret-scanning/alerts?state=open&per_page=100`]: { body: [] },
    [`/repos/${repo}/dependabot/alerts?state=open&severity=medium,high,critical&per_page=100`]: { body: [] },
    [`/repos/${repo}/code-scanning/analyses?ref=refs/heads/main&tool_name=CodeQL&per_page=100`]: { body: [
      { category: '/language:javascript-typescript', commit_sha: source },
      { category: '/language:actions', commit_sha: later },
      { category: '/language:actions', commit_sha: older },
    ] },
    [`/repos/${repo}/compare/${source}...${later}`]: { body: { status: 'ahead' } },
    [`/repos/${repo}/compare/${source}...${older}`]: { body: { status: 'behind' } },
  };
}

async function withApi(routes: Routes, run: (apiUrl: string, seen: IncomingMessage[]) => Promise<void>): Promise<void> {
  const seen: IncomingMessage[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    seen.push(request);
    const reply = routes[request.url ?? ''];
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (reply?.link) headers.link = reply.link.replaceAll('API', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    response.writeHead(reply ? reply.status ?? 200 : 404, headers);
    response.end(JSON.stringify(reply ? reply.body : { message: 'Not Found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function gate(apiUrl: string, secretScanningToken = 'secret-read') {
  return releaseGate({ repository: repo, sourceSha: source, token: 'workflow', secretScanningToken, apiUrl });
}

test('the gate passes a green status, no blocking alerts and CodeQL analyses that include the source', async () => {
  await withApi(cleanRoutes(), async (apiUrl, seen) => {
    assert.deepEqual(await gate(apiUrl), []);
    const secret = seen.find((request) => request.url?.includes('secret-scanning'));
    assert.equal(secret?.headers.authorization, 'Bearer secret-read');
    assert.ok(seen.filter((request) => request !== secret).every((request) => request.headers.authorization === 'Bearer workflow'));
  });
});

test('the gate refuses a source commit without the security-gate status and names it', async () => {
  const routes = cleanRoutes();
  routes[`/repos/${repo}/commits/${source}/statuses?per_page=100`] = { body: [{ context: 'ci', state: 'success' }] };
  await withApi(routes, async (apiUrl) => {
    assert.deepEqual(await gate(apiUrl), [`security-gate status is missing on ${source}`]);
  });
});

for (const [state, description] of [['failure', 'Open findings: 2'], ['pending', 'Scanning'], ['error', '']] as const) {
  test(`the gate refuses a security-gate status that is ${state}`, async () => {
    const routes = cleanRoutes();
    routes[`/repos/${repo}/commits/${source}/statuses?per_page=100`] = { body: [{ context: 'security-gate', state, description }] };
    await withApi(routes, async (apiUrl) => {
      assert.deepEqual(await gate(apiUrl), [`security-gate status is ${state} on ${source}${description ? `: ${description}` : ''}`]);
    });
  });
}

test('the gate refuses a green status with one open medium code scanning alert, found on a later page', async () => {
  const routes = cleanRoutes();
  const first = `/repos/${repo}/code-scanning/alerts?state=open&ref=refs/heads/main&per_page=100`;
  routes[first] = { ...routes[first]!, link: '<API/next-alerts?page=2>; rel="next", <API/next-alerts?page=2>; rel="last"' };
  routes['/next-alerts?page=2'] = { body: [{ number: 12, rule: { severity: 'warning', security_severity_level: 'medium' } }] };
  await withApi(routes, async (apiUrl) => {
    assert.deepEqual(await gate(apiUrl), ['1 open code scanning alert(s) of medium or higher on main: #12']);
  });
});

test('the gate refuses an open code scanning alert of severity error without a security severity', async () => {
  const routes = cleanRoutes();
  routes[`/repos/${repo}/code-scanning/alerts?state=open&ref=refs/heads/main&per_page=100`] = { body: [{ number: 3, rule: { severity: 'error', security_severity_level: null } }] };
  await withApi(routes, async (apiUrl) => {
    assert.deepEqual(await gate(apiUrl), ['1 open code scanning alert(s) of medium or higher on main: #3']);
  });
});

test('the gate refuses open secret scanning and Dependabot alerts, naming each reason', async () => {
  const routes = cleanRoutes();
  routes[`/repos/${repo}/secret-scanning/alerts?state=open&per_page=100`] = { body: [{ number: 1 }] };
  routes[`/repos/${repo}/dependabot/alerts?state=open&severity=medium,high,critical&per_page=100`] = { body: [
    { number: 4, security_advisory: { severity: 'high' } },
    { number: 5, security_advisory: { severity: 'low' } },
  ] };
  await withApi(routes, async (apiUrl) => {
    assert.deepEqual(await gate(apiUrl), [
      '1 open secret scanning alert(s): #1',
      '1 open Dependabot alert(s) of medium or higher: #4',
    ]);
  });
});

test('the gate refuses when a CodeQL category was last analyzed before the source commit', async () => {
  const routes = cleanRoutes();
  routes[`/repos/${repo}/code-scanning/analyses?ref=refs/heads/main&tool_name=CodeQL&per_page=100`] = { body: [
    { category: '/language:javascript-typescript', commit_sha: older },
    { category: '/language:actions', commit_sha: later },
  ] };
  await withApi(routes, async (apiUrl) => {
    assert.deepEqual(await gate(apiUrl), [`the latest CodeQL analysis on main does not cover ${source}: /language:javascript-typescript (${older}) does not include it`]);
  });
});

test('the gate refuses a CodeQL category whose latest analysis failed, and finds a category on a later page', async () => {
  const routes = cleanRoutes();
  const first = `/repos/${repo}/code-scanning/analyses?ref=refs/heads/main&tool_name=CodeQL&per_page=100`;
  routes[first] = { body: [
    { category: '/language:javascript-typescript', commit_sha: source, error: 'Analysis failed during processing' },
    { category: '/language:javascript-typescript', commit_sha: older, error: '' },
  ], link: '<API/next-analyses?page=2>; rel="next"' };
  routes['/next-analyses?page=2'] = { body: [{ category: '/language:actions', commit_sha: older, error: '' }] };
  await withApi(routes, async (apiUrl) => {
    assert.deepEqual(await gate(apiUrl), [
      `the latest CodeQL analysis on main does not cover ${source}: /language:javascript-typescript (${source}) failed: Analysis failed during processing; /language:actions (${older}) does not include it`,
    ]);
  });
});

test('the gate names an answer that is not JSON and an unreachable API as reasons instead of stopping', async () => {
  const routes = cleanRoutes();
  routes[`/repos/${repo}/dependabot/alerts?state=open&severity=medium,high,critical&per_page=100`] = { body: undefined };
  await withApi(routes, async (apiUrl) => {
    const reasons = await gate(apiUrl);
    assert.deepEqual(reasons, ['Cannot read Dependabot alerts: the API did not return JSON']);
  });
  const reasons = await gate('http://127.0.0.1:9');
  assert.equal(reasons.length, 5);
  assert.ok(reasons.every((reason) => reason.startsWith('Cannot read ')), reasons.join('\n'));
});

test('the gate refuses when it cannot read a check, and without a secret scanning token', async () => {
  const routes = cleanRoutes();
  routes[`/repos/${repo}/dependabot/alerts?state=open&severity=medium,high,critical&per_page=100`] = { status: 403, body: { message: 'Resource not accessible by integration' } };
  delete routes[`/repos/${repo}/code-scanning/analyses?ref=refs/heads/main&tool_name=CodeQL&per_page=100`];
  await withApi(routes, async (apiUrl, seen) => {
    assert.deepEqual(await gate(apiUrl, ''), [
      'secret scanning alerts were not read: no token with Secret scanning alerts read access was given',
      'Cannot read Dependabot alerts: HTTP 403 Resource not accessible by integration',
      'Cannot read CodeQL analyses: HTTP 404 Not Found',
    ]);
    assert.ok(!seen.some((request) => request.url?.includes('secret-scanning')));
  });
});

test('the gate never follows a page link to another host with its token', async () => {
  const routes = cleanRoutes();
  routes[`/repos/${repo}/secret-scanning/alerts?state=open&per_page=100`] = { body: [], link: '<https://elsewhere.example/alerts?page=2>; rel="next"' };
  await withApi(routes, async (apiUrl) => {
    assert.deepEqual(await gate(apiUrl), [`Cannot read secret scanning alerts: the API answered with a link outside ${apiUrl}`]);
  });
});

test('the gate rejects a malformed repository or source commit before any request', async () => {
  await assert.rejects(releaseGate({ repository: 'example/project/../x', sourceSha: source, token: 't' }), /owner\/name/);
  await assert.rejects(releaseGate({ repository: repo, sourceSha: 'main', token: 't' }), /full lowercase commit SHA/);
  await assert.rejects(releaseGate({ repository: repo, sourceSha: source, token: '' }), /token is required/);
});

test('release.yml gates final versions only and builds a final version only after the gate passed', async () => {
  const workflow = parse(await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const { gate: gateJob, build, tag } = workflow.jobs;
  // Every version the build accepts with a hyphen is a pre-release, so the hyphen test separates them.
  for (const version of ['v0.1.0-rc.1', 'v1.0.0-beta']) assert.ok(validateVersion(version).includes('-'));
  assert.equal(validateVersion('v1.2.3'), '1.2.3');
  assert.equal(gateJob.if, "github.ref == 'refs/heads/main' && !contains(inputs.version, '-')");
  assert.deepEqual(gateJob.permissions, { contents: 'read', statuses: 'read', 'security-events': 'read', 'vulnerability-alerts': 'read' });
  const step = gateJob.steps.at(-1);
  assert.equal(step.run, 'node src/release/gate.ts "$GITHUB_REPOSITORY" "$SOURCE_SHA"');
  assert.deepEqual(Object.keys(step.env).sort(), ['GITHUB_TOKEN', 'SECRET_SCANNING_TOKEN']);
  assert.equal(gateJob.steps[0].with['persist-credentials'], false);
  assert.equal(build.needs, 'gate');
  assert.equal(build.if, "${{ !cancelled() && github.ref == 'refs/heads/main' && (needs.gate.result == 'success' || (needs.gate.result == 'skipped' && contains(inputs.version, '-'))) }}");
  assert.deepEqual(tag.needs, ['gate', 'build', 'attest']);
  assert.equal(tag.if, "${{ !cancelled() && needs.build.result == 'success' && ((needs.gate.result == 'success' && needs.attest.result == 'success') || (needs.gate.result == 'skipped' && contains(inputs.version, '-'))) }}",
    'the tag job must run whenever the build succeeded, and for a final version only after the gate passed and the release was attested');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
});

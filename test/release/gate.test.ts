import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { evaluate, parseExceptions } from '../../src/release/dependency-scan.ts';
import { parseCreatorId, releaseGate } from '../../src/release/gate.ts';
import { validateVersion } from '../../src/release/package.ts';

const repo = 'example/project';
const source = 'a'.repeat(40);
const later = 'b'.repeat(40);
const older = 'c'.repeat(40);
const scanner = { login: 'scanner', id: 4242, type: 'User' };
const intruder = { login: 'someone-else', id: 777, type: 'User' };

// Dependency scan results as the gate job's scan step writes them.
const results = mkdtempSync(join(tmpdir(), 'gate-dependencies-'));
function dependencyResult(name: string, commit: string, audit: unknown): string {
  const result = evaluate({
    target: 'release v1.0.0', commit, release: 'v1.0.0', checked: '2026-11-16T00:00:00Z',
    audits: [{ lockFile: 'package-lock.json', audit }], exceptions: parseExceptions('{"exceptions":[]}', '2026-11-16'),
  });
  const path = join(results, `${name}.json`);
  writeFileSync(path, JSON.stringify(result));
  return path;
}
const advisory = (id: string, name: string, severity: string) => ({ source: 1, name, title: `${name} issue`, url: `https://github.com/advisories/${id}`, severity, range: '*' });
const cleanDependencies = dependencyResult('clean', source, { vulnerabilities: {} });

interface Reply { status?: number; body: unknown; link?: string }
type Routes = Record<string, Reply>;

// A clean repository: a green gate status, no open alerts, and CodeQL analyses at the source commit.
function cleanRoutes(): Routes {
  return {
    [`/repos/${repo}/commits/${source}/statuses?per_page=100`]: { body: [
      { context: 'ci', state: 'failure' },
      { context: 'security-gate', state: 'success', description: 'No open findings', creator: scanner },
      { context: 'security-gate', state: 'failure', description: 'An older run', creator: scanner },
    ] },
    [`/repos/${repo}/code-scanning/alerts?state=open&ref=refs/heads/main&per_page=100`]: { body: [
      { number: 7, rule: { severity: 'warning', security_severity_level: 'low' } },
      { number: 8, rule: { severity: 'note', security_severity_level: null } },
    ] },
    [`/repos/${repo}/secret-scanning/alerts?state=open&per_page=100`]: { body: [] },
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

function gate(apiUrl: string, secretScanningToken = 'secret-read', dependencies: string | null = cleanDependencies) {
  return releaseGate({ repository: repo, sourceSha: source, token: 'workflow', statusCreatorId: scanner.id, secretScanningToken, dependencyResult: dependencies ?? undefined, apiUrl });
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
    routes[`/repos/${repo}/commits/${source}/statuses?per_page=100`] = { body: [{ context: 'security-gate', state, description, creator: scanner }] };
    await withApi(routes, async (apiUrl) => {
      assert.deepEqual(await gate(apiUrl), [`security-gate status is ${state} on ${source}${description ? `: ${description}` : ''}`]);
    });
  });
}

test('the gate refuses a green security-gate status posted by another account, even over an older trusted one', async () => {
  const routes = cleanRoutes();
  routes[`/repos/${repo}/commits/${source}/statuses?per_page=100`] = { body: [
    { context: 'security-gate', state: 'success', description: 'No open findings', creator: intruder },
    { context: 'security-gate', state: 'success', description: 'No open findings', creator: scanner },
  ] };
  await withApi(routes, async (apiUrl) => {
    assert.deepEqual(await gate(apiUrl), [`security-gate status on ${source} was posted by someone-else (id 777), not by the configured account (id 4242)`]);
  });
});

test('the gate passes a newer trusted status over an older one from another account', async () => {
  const routes = cleanRoutes();
  routes[`/repos/${repo}/commits/${source}/statuses?per_page=100`] = { body: [
    { context: 'security-gate', state: 'success', description: 'No open findings', creator: scanner },
    { context: 'security-gate', state: 'failure', description: 'Not from the scanner', creator: intruder },
  ] };
  await withApi(routes, async (apiUrl) => {
    assert.deepEqual(await gate(apiUrl), []);
  });
});

test('the gate names a creator without a numeric id by login only', async () => {
  const routes = cleanRoutes();
  routes[`/repos/${repo}/commits/${source}/statuses?per_page=100`] = { body: [{ context: 'security-gate', state: 'success', creator: { login: 'scanner', id: '4242' } }] };
  await withApi(routes, async (apiUrl) => {
    assert.deepEqual(await gate(apiUrl), [`security-gate status on ${source} was posted by scanner, not by the configured account (id 4242)`]);
  });
});

test('the creator id setting accepts plain digits only', () => {
  assert.equal(parseCreatorId('16704707'), 16704707);
  for (const bad of [undefined, '', ' 7', '7 ', '0', '07', '-7', '0x10', '1e3', '1.5', 'scanner']) {
    assert.ok(Number.isNaN(parseCreatorId(bad)), String(bad));
  }
});

test('the gate refuses a security-gate status without a creator', async () => {
  const routes = cleanRoutes();
  routes[`/repos/${repo}/commits/${source}/statuses?per_page=100`] = { body: [{ context: 'security-gate', state: 'success', creator: null }] };
  await withApi(routes, async (apiUrl) => {
    assert.deepEqual(await gate(apiUrl), [`security-gate status on ${source} was posted by an unknown account, not by the configured account (id 4242)`]);
  });
});

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

test('the gate refuses open secret scanning alerts and dependency advisories of moderate or higher, naming each reason', async () => {
  const routes = cleanRoutes();
  routes[`/repos/${repo}/secret-scanning/alerts?state=open&per_page=100`] = { body: [{ number: 1 }] };
  const vulnerable = dependencyResult('vulnerable', source, { vulnerabilities: {
    a: { via: [advisory('GHSA-xvch-5gv4-984h', 'a', 'moderate')] },
    b: { via: [advisory('GHSA-35jh-r3h4-6jhm', 'b', 'high'), 'a'] },
    c: { via: [advisory('GHSA-29mw-wpgm-hmr9', 'c', 'low')] },
  } });
  await withApi(routes, async (apiUrl) => {
    assert.deepEqual(await gate(apiUrl, 'secret-read', vulnerable), [
      '1 open secret scanning alert(s): #1',
      '2 open dependency advisories of moderate or higher: GHSA-35jh-r3h4-6jhm (high), GHSA-xvch-5gv4-984h (moderate)',
    ]);
  });
});

test('the gate refuses without a dependency scan result of the source commit', async () => {
  await withApi(cleanRoutes(), async (apiUrl) => {
    assert.deepEqual(await gate(apiUrl, 'secret-read', null), ['the dependencies were not checked: no dependency scan result was given']);
    const missing = join(results, 'missing.json');
    const reasons = await gate(apiUrl, 'secret-read', missing);
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, /^Cannot read the dependency scan result: ENOENT/);
    writeFileSync(join(results, 'other.json'), '{"schema":2}');
    assert.deepEqual(await gate(apiUrl, 'secret-read', join(results, 'other.json')), [`Cannot read the dependency scan result: ${join(results, 'other.json')} is not a dependency scan result`]);
    assert.deepEqual(await gate(apiUrl, 'secret-read', dependencyResult('older', older, { vulnerabilities: {} })), [`the dependency scan checked ${older}, not ${source}`]);
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
  routes[`/repos/${repo}/secret-scanning/alerts?state=open&per_page=100`] = { body: undefined };
  await withApi(routes, async (apiUrl) => {
    const reasons = await gate(apiUrl);
    assert.deepEqual(reasons, ['Cannot read secret scanning alerts: the API did not return JSON']);
  });
  const reasons = await gate('http://127.0.0.1:9');
  assert.equal(reasons.length, 4);
  assert.ok(reasons.every((reason) => reason.startsWith('Cannot read ')), reasons.join('\n'));
});

test('the gate refuses when it cannot read a check, and without a secret scanning token', async () => {
  const routes = cleanRoutes();
  routes[`/repos/${repo}/code-scanning/alerts?state=open&ref=refs/heads/main&per_page=100`] = { status: 403, body: { message: 'Resource not accessible by integration' } };
  delete routes[`/repos/${repo}/code-scanning/analyses?ref=refs/heads/main&tool_name=CodeQL&per_page=100`];
  await withApi(routes, async (apiUrl, seen) => {
    assert.deepEqual(await gate(apiUrl, ''), [
      'Cannot read code scanning alerts: HTTP 403 Resource not accessible by integration',
      'secret scanning alerts were not read: no token with Secret scanning alerts read access was given',
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
  const statusCreatorId = scanner.id;
  await assert.rejects(releaseGate({ repository: 'example/project/../x', sourceSha: source, token: 't', statusCreatorId }), /owner\/name/);
  await assert.rejects(releaseGate({ repository: repo, sourceSha: 'main', token: 't', statusCreatorId }), /full lowercase commit SHA/);
  await assert.rejects(releaseGate({ repository: repo, sourceSha: source, token: '', statusCreatorId }), /token is required/);
  for (const bad of [Number.NaN, 0, -1, 1.5]) {
    await assert.rejects(releaseGate({ repository: repo, sourceSha: source, token: 't', statusCreatorId: bad }), /status creator as a positive GitHub account id/);
  }
});

test('release.yml gates final versions only and builds a final version only after the gate passed', async () => {
  const workflow = parse(await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const { gate: gateJob, test: tests, build, tag } = workflow.jobs;
  // Every version the build accepts with a hyphen is a pre-release, so the hyphen test separates them.
  for (const version of ['v0.1.0-rc.1', 'v1.0.0-beta']) assert.ok(validateVersion(version).includes('-'));
  assert.equal(validateVersion('v1.2.3'), '1.2.3');
  assert.equal(gateJob.if, "github.ref == 'refs/heads/main' && !contains(inputs.version, '-')");
  assert.deepEqual(gateJob.permissions, { contents: 'read', statuses: 'read', 'security-events': 'read' });
  const step = gateJob.steps.find((candidate: { name?: string }) => candidate.name === 'Check the security gate');
  assert.equal(step.run, 'node src/release/gate.ts "$GITHUB_REPOSITORY" "$SOURCE_SHA"');
  assert.deepEqual(Object.keys(step.env).sort(), ['DEPENDENCY_RESULT', 'GITHUB_TOKEN', 'SECRET_SCANNING_TOKEN', 'SECURITY_GATE_CREATOR_ID']);
  // The dependency check runs on the source's lock files only, from main's code, and a failed check reaches the gate as a reason.
  const scan = gateJob.steps.find((candidate: { name?: string }) => candidate.name === 'Check the dependencies of the source');
  assert.equal(scan['continue-on-error'], true);
  assert.ok(gateJob.steps.indexOf(scan) < gateJob.steps.indexOf(step));
  assert.match(scan.run, /^node src\/release\/dependency-scan\.ts --repository source --commit "\$SOURCE_SHA" /);
  assert.equal(step.env.DEPENDENCY_RESULT, '${{ runner.temp }}/dependencies/dependency-result.json');
  const source = gateJob.steps.find((candidate: { with?: { path?: string } }) => candidate.with?.path === 'source');
  assert.deepEqual(source.with, { ref: '${{ inputs.source-sha }}', path: 'source', 'persist-credentials': false });
  assert.match(step.env.SECURITY_GATE_CREATOR_ID, /^[1-9][0-9]*$/);
  assert.equal(gateJob.steps[0].with['persist-credentials'], false);
  assert.equal(tests.needs, 'gate');
  assert.equal(tests.if, "${{ !cancelled() && github.ref == 'refs/heads/main' && (needs.gate.result == 'success' || (needs.gate.result == 'skipped' && contains(inputs.version, '-'))) }}");
  assert.deepEqual(build.needs, ['gate', 'test']);
  assert.equal(build.if, "${{ !cancelled() && github.ref == 'refs/heads/main' && needs.test.result == 'success' && (needs.gate.result == 'success' || (needs.gate.result == 'skipped' && contains(inputs.version, '-'))) }}");
  assert.deepEqual(tag.needs, ['gate', 'report', 'build', 'attest']);
  assert.equal(tag.if, "${{ !cancelled() && needs.build.result == 'success' && ((needs.gate.result == 'success' && needs.report.result == 'success' && needs.attest.result == 'success') || (needs.gate.result == 'skipped' && contains(inputs.version, '-'))) }}",
    'the tag job must run whenever the build succeeded, and for a final version only after the gate passed, the security report was written and the release was attested');
  assert.deepEqual(workflow.permissions, { contents: 'read' });
});

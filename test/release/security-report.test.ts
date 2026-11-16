import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { evaluate, parseExceptions, type Result as DependencyResult } from '../../src/release/dependency-scan.ts';
import { ACCEPTED_RISKS_FILE, acceptedRiskEntries, literal, securityReport, toolName } from '../../src/release/security-report.ts';

const repo = 'example/project';
const source = 'a'.repeat(40);
const older = 'c'.repeat(40);
const privateLink = 'https://github.com/example/private-scans/issues/12';

type Routes = Record<string, unknown>;

const fable = { name: 'Fable', version: '5.2' };
const astra = { name: 'GPT-6 Astra', version: '' };
const codeql = { name: 'CodeQL', version: '2.25.1' };

function alert(tool: { name: string }, category: string, severity: string, extra: Record<string, unknown> = {}, commit = source) {
  return {
    tool, rule: { id: `rule-${severity}`, description: `A ${severity} finding`, security_severity_level: severity },
    most_recent_instance: { category, commit_sha: commit, ref: 'refs/heads/main' }, ...extra,
  };
}

// A release whose three scans ran on the source commit, with one dismissed finding each kind of way.
function routes(): Routes {
  return {
    [`/repos/${repo}/code-scanning/analyses?ref=refs/heads/main&per_page=100`]: [
      { category: 'astra', commit_sha: source, tool: astra },
      { category: 'fable', commit_sha: source, tool: fable },
      { category: '/language:javascript-typescript', commit_sha: source, tool: codeql },
      { category: '/language:actions', commit_sha: source, tool: codeql },
      { category: 'fable', commit_sha: older, tool: { name: 'Fable', version: '5.1' } },
      { category: '/language:actions', commit_sha: older, tool: { name: 'CodeQL', version: '2.24.0' } },
    ],
    [`/repos/${repo}/code-scanning/alerts?state=open&ref=refs/heads/main&per_page=100`]: [
      alert(fable, 'fable', 'low'),
      alert(codeql, '/language:actions', 'note'),
    ],
    [`/repos/${repo}/code-scanning/alerts?state=dismissed&ref=refs/heads/main&per_page=100`]: [
      alert(fable, 'fable', 'high', {
        rule: { id: 'f1', description: 'Merge lands on a retargeted *base* | see https://example.com/x', security_severity_level: 'high' },
        dismissed_reason: "won't fix", dismissed_comment: `Accepted risk, see ${privateLink}`,
      }),
      alert(astra, 'astra', 'medium', { dismissed_reason: 'false positive', dismissed_comment: `Proof in ${privateLink}` }),
      // Dismissed on an older commit and no longer reported: not part of this release.
      alert(fable, 'fable', 'critical', { dismissed_reason: 'false positive' }, older),
    ],
  };
}

async function withApi(replies: Routes, run: (apiUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const found = Object.hasOwn(replies, request.url ?? '');
    response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(found ? replies[request.url!] : { message: 'Not Found' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const acceptedRisks = await readFile(new URL(`../../${ACCEPTED_RISKS_FILE}`, import.meta.url), 'utf8');
// The dependency check of the source, as the release gate ran it.
function dependencyScan(vulnerabilities: Record<string, unknown> = {}, commit = source): DependencyResult {
  return evaluate({
    target: 'release v0.1.0', commit, release: 'v0.1.0', checked: '2026-11-16T00:00:00Z',
    audits: [{ lockFile: 'package-lock.json', audit: { vulnerabilities } }], exceptions: parseExceptions('{"exceptions":[]}', '2026-11-16'),
  });
}
const advisory = (id: string, name: string, severity: string) => ({ source: 1, name, title: 't', url: `https://github.com/advisories/${id}`, severity });
const report = (apiUrl: string, version = 'v0.1.0', dependencies = dependencyScan()) => securityReport({ repository: repo, sourceSha: source, version, token: 't', acceptedRisks, dependencies, apiUrl, date: '2026-11-16' });

test('the summary names each scan that ran with the version from its run, in display order, with high and critical counts', async () => {
  await withApi(routes(), async (apiUrl) => {
    const { summary } = await report(apiUrl);
    assert.deepEqual(summary, {
      schema: 1, release: 'v0.1.0', sourceCommit: source, date: '2026-11-16', report: 'security-report.md',
      tools: [
        { id: 'fable', name: 'Fable 5.2', high: 0, critical: 0 },
        { id: 'astra', name: 'GPT-6 Astra', high: 0, critical: 0 },
        { id: 'codeql', name: 'CodeQL', high: 0, critical: 0 },
        { id: 'dependencies', name: 'Dependencies', high: 0, critical: 0 },
      ],
    });
  });
});

test('open findings of severity high and critical are counted per tool, lower ones only in the report', async () => {
  const replies = routes();
  replies[`/repos/${repo}/code-scanning/alerts?state=open&ref=refs/heads/main&per_page=100`] = [
    alert(fable, 'fable', 'high'), alert(fable, 'fable', 'critical'), alert(fable, 'fable', 'critical'),
    alert(astra, 'astra', 'medium'), alert(codeql, '/language:javascript-typescript', 'high'),
    // An alert of another tool or category counts for none of the shown tools.
    alert({ name: 'Other' }, 'other', 'critical'),
  ];
  // Each advisory counts once, at its own severity; a package vulnerable only through another adds nothing.
  const dependencies = dependencyScan({
    a: { via: [advisory('GHSA-xvch-5gv4-984h', 'a', 'critical'), advisory('GHSA-35jh-r3h4-6jhm', 'a', 'high')] },
    b: { via: [advisory('GHSA-r5fr-rjxr-66jc', 'b', 'high'), advisory('GHSA-29mw-wpgm-hmr9', 'b', 'moderate'), 'a'] },
    c: { via: ['a', 'b'] },
  });
  await withApi(replies, async (apiUrl) => {
    const { summary, report: markdown } = await report(apiUrl, 'v0.1.0', dependencies);
    assert.deepEqual(summary.tools.map(({ id, high, critical }) => [id, high, critical]), [
      ['fable', 1, 2], ['astra', 0, 0], ['codeql', 1, 0], ['dependencies', 2, 1],
    ]);
    assert.match(markdown, /\| Fable 5\\\.2 \| 5\\\.2 \| `aaaaaaaaaaaa` \| 2 \| 1 \| 0 \| 1 \|/);
    assert.match(markdown, /\| GPT\\-6 Astra \| not reported \| `aaaaaaaaaaaa` \| 0 \| 0 \| 1 \| 1 \|/);
  });
});

test('a scan that did not run on the source commit has no entry in the summary and the report says so', async () => {
  const replies = routes();
  replies[`/repos/${repo}/code-scanning/analyses?ref=refs/heads/main&per_page=100`] = [
    { category: 'fable', commit_sha: source, tool: fable },
    { category: 'astra', commit_sha: older, tool: astra },
    { category: '/language:actions', commit_sha: source, tool: codeql },
  ];
  await withApi(replies, async (apiUrl) => {
    const { summary, report: markdown } = await report(apiUrl);
    assert.deepEqual(summary.tools.map((tool) => tool.id), ['fable', 'codeql', 'dependencies']);
    assert.match(markdown, /^Did not run on this release: Astra review\.$/m);
    assert.doesNotMatch(markdown, /^## GPT/m);
  });
});

test('the report lists each dismissed finding of the release with its reason, as literal text and without its comment', async () => {
  await withApi(routes(), async (apiUrl) => {
    const { report: markdown } = await report(apiUrl);
    assert.match(markdown, /^# Security report for mdbisync v0\.1\.0$/m);
    assert.match(markdown, new RegExp(`^Source commit: \`${source}\`\\. Report date: 2026-11-16\\.$`, 'm'));
    assert.match(markdown, /A clean result is not\s+a proof of security/);
    assert.match(markdown, /^\| high \| Merge lands on a retargeted \\\*base\\\* \\\| see \\\(link removed\\\) \| Won't fix \|$/m);
    assert.match(markdown, /^\| medium \| A medium finding \| False positive \|$/m);
    assert.doesNotMatch(markdown, /A critical finding/, 'a finding dismissed on an older commit is not part of the release');
    assert.match(markdown, /^## CodeQL\n\nGitHub CodeQL/m);
    assert.match(markdown, /^Dismissed findings: none\.$/m);
  });
});

test('the report carries every accepted risk one heading level down, and None without any', async () => {
  await withApi(routes(), async (apiUrl) => {
    const { report: markdown } = await report(apiUrl);
    const section = markdown.slice(markdown.indexOf('## Accepted risks'));
    const entries = [...acceptedRisks.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    assert.ok(entries.length > 0);
    for (const entry of entries) assert.ok(section.includes(`\n### ${entry}\n`), entry);
  });
  assert.equal(acceptedRiskEntries('# Accepted risks\n\nNone yet.\n'), 'None.\n');
  assert.equal(acceptedRiskEntries('# A\n\n## One\n\nText.\n\n### Detail\n'), '### One\n\nText.\n\n#### Detail\n');
});

test('the generated files hold nothing private: no dismissal comments, private links, hosts or local paths', async () => {
  await withApi(routes(), async (apiUrl) => {
    const { report: markdown, summary } = await report(apiUrl);
    for (const text of [markdown, JSON.stringify(summary)]) {
      assert.ok(!text.includes('private-scans'));
      assert.ok(!text.includes('Accepted risk, see'));
      assert.ok(!text.includes('127.0.0.1'));
      assert.doesNotMatch(text, /\/home\/|\/Users\/|issues\/\d/);
    }
  });
});

test('the report is refused for a pre-release, a malformed input or an unexpected tool name', async () => {
  await assert.rejects(report('http://127.0.0.1:1', 'v0.1.0-rc.1'), /only for a final version/);
  const dependencies = dependencyScan();
  await assert.rejects(securityReport({ repository: 'a/b/c', sourceSha: source, version: 'v0.1.0', token: 't', acceptedRisks, dependencies }), /owner\/name/);
  await assert.rejects(securityReport({ repository: repo, sourceSha: source, version: 'v0.1.0', token: '', acceptedRisks, dependencies }), /token is required/);
  await assert.rejects(report('http://127.0.0.1:1', 'v0.1.0', dependencyScan({}, older)), new RegExp(`dependency scan checked ${older}, not ${source}`));
  const replies = routes();
  replies[`/repos/${repo}/code-scanning/analyses?ref=refs/heads/main&per_page=100`] = [
    { category: 'fable', commit_sha: source, tool: { name: '<b>Fable</b>', version: '5.2' } },
  ];
  await withApi(replies, async (apiUrl) => {
    await assert.rejects(report(apiUrl), /Unexpected tool name/);
  });
});

test('a release scan whose analysis GitHub could not process refuses the report instead of reading as clean', async () => {
  const replies = routes();
  replies[`/repos/${repo}/code-scanning/analyses?ref=refs/heads/main&per_page=100`] = [
    { category: 'fable', commit_sha: source, tool: fable, error: 'SARIF processing failed' },
    { category: 'astra', commit_sha: source, tool: astra },
  ];
  await withApi(replies, async (apiUrl) => {
    await assert.rejects(report(apiUrl), /The Fable review analysis of a{40} failed: SARIF processing failed/);
  });
});

test('only alerts whose newest instance is an analyzed commit count, and a later review analysis refuses the report', async () => {
  const later = 'b'.repeat(40);
  const replies = routes();
  replies[`/repos/${repo}/code-scanning/alerts?state=open&ref=refs/heads/main&per_page=100`] = [
    alert(fable, 'fable', 'critical'),
    alert(fable, 'fable', 'high', {}, later),
  ];
  await withApi(replies, async (apiUrl) => {
    const { summary } = await report(apiUrl);
    assert.deepEqual(summary.tools.find((tool) => tool.id === 'fable'), { id: 'fable', name: 'Fable 5.2', high: 0, critical: 1 });
  });
  replies[`/repos/${repo}/code-scanning/analyses?ref=refs/heads/main&per_page=100`] = [
    { category: 'fable', commit_sha: later, tool: { name: 'Fable', version: '5.3' } },
    ...(replies[`/repos/${repo}/code-scanning/analyses?ref=refs/heads/main&per_page=100`] as unknown[]),
  ];
  await withApi(replies, async (apiUrl) => {
    await assert.rejects(report(apiUrl), /A later Fable review analysis \(b{40}\) replaced the one of the source commit/);
  });
});

test('dismissed findings are listed from the most severe, with an unknown severity last', async () => {
  const replies = routes();
  replies[`/repos/${repo}/code-scanning/alerts?state=dismissed&ref=refs/heads/main&per_page=100`] = [
    alert(fable, 'fable', 'low', { rule: { id: 'u', description: 'No severity' }, dismissed_reason: 'used in tests' }),
    alert(fable, 'fable', 'medium', { dismissed_reason: 'false positive' }),
    alert(fable, 'fable', 'critical', { dismissed_reason: "won't fix" }),
  ];
  await withApi(replies, async (apiUrl) => {
    const { report: markdown } = await report(apiUrl);
    const rows = [...markdown.matchAll(/^\| (\w+) \| [^|]+ \| (False positive|Won't fix|Used in tests) \|$/gm)].map((match) => match[1]);
    assert.deepEqual(rows, ['critical', 'medium', 'unknown']);
  });
});

test('a tool name joins the reported name and version once, and untrusted text becomes literal', () => {
  assert.equal(toolName('Fable', '5.2'), 'Fable 5.2');
  assert.equal(toolName('Fable 5.2', '5.2'), 'Fable 5.2');
  assert.equal(toolName('GPT-6 Astra', undefined), 'GPT-6 Astra');
  assert.throws(() => toolName('', ''), /Unexpected tool name/);
  assert.throws(() => toolName('x'.repeat(41), ''), /Unexpected tool name/);
  assert.equal(literal('a\n<img src=x>|`b`'), 'a \\<img src\\=x\\>\\|\\`b\\`');
  assert.equal(literal('see www.example.com now'), 'see \\(link removed\\) now');
  assert.equal([...literal('é'.repeat(300))].length, 200);
});

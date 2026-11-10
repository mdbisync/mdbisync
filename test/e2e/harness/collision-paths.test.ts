import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { it } from 'node:test';
import { collectAnnotations, mapFiles, resolveZones } from '../../../src/mapping/index.ts';
import { planInitialSync } from '../../../src/initial-sync/plan.ts';
import { toPlanReport } from '../../../src/initial-sync/summary.ts';
import { copyBank } from '../../corpus/bank.ts';
import { Canaries } from '../../corpus/model.ts';
import { COLLISIONS, EDGE_ZONE } from '../../corpus/tree.ts';
import { BANK_DIR } from '../../probe/bank.ts';
import type { RunContext } from './context.ts';
import { buildRunTree, type Manifest } from './corpus.ts';
import { evaluateAssertion } from './checks.ts';
import { REPO_ROOT, type EngineResult } from './engine.ts';
import { runNames } from './isolation.ts';
import { loadScenarios } from './spec.ts';
import { resolveSubject } from './subjects.ts';

it('checks both bank collision pairs at their exact run paths against the initial-sync report', async () => {
  const bank = copyBank(join(REPO_ROOT, BANK_DIR), new Canaries(() => '00000000'));
  const manifest: Manifest = { seed: 'test', files: bank.files.map((file) => ({
    path: file.path, group: file.group, kind: file.kind, synced: file.synced,
    lfs: false, canary: file.canary, class: file.expected, rule: file.rule,
  })) };
  const sources = bank.files.filter((file) => file.rule === 'duplicate-title');
  assert.equal(sources.length, 4);
  const readmes = new Map([[`${EDGE_ZONE}/README.md`, '---\nlinear-team: ENG\n---\n']]);
  const names = runNames('a1b2c3');
  const tree = buildRunTree({ slice: 'bank', paths: [...readmes.keys(), ...sources.map((file) => file.path)] }, readmes, names);
  const sourceBytes = new Map<string, Buffer>([...readmes].map(([path, text]) => [path, Buffer.from(text)]));
  for (const file of sources) sourceBytes.set(file.path, file.content);
  const blobs = new Map<string, Buffer>();
  const texts = new Map<string, string>();
  const entries = [...tree.paths].map(([path, source]) => {
    const bytes = sourceBytes.get(source)!;
    const oid = createHash('sha1').update(path).update(bytes).digest('hex');
    blobs.set(oid, bytes);
    texts.set(path, bytes.toString('utf8'));
    return { path, oid, mode: '100644', type: 'blob' as const, size: bytes.length };
  });
  const { annotations, problems } = collectAnnotations(readmes);
  const resolved = resolveZones(annotations);
  assert.deepEqual([...problems, ...resolved.problems], []);
  const mapping = { annotations, problems: [], zones: resolved.zones, ...mapFiles(entries, resolved.zones, blobs) };
  const report = toPlanReport(planInitialSync({ mapping, texts, places: [] }), 'git-to-linear', false);
  const prefix = `${EDGE_ZONE}/${names.runId}/${COLLISIONS.slice(EDGE_ZONE.length + 1)}`;
  const expected = ['Guide.md', 'guide.md', 'caf\u00e9.md', 'cafe\u0301.md'].map((name) => `${prefix}/${name}`).sort();
  assert.deepEqual(report.collisionPaths, expected);
  const ctx = {
    live: { manifest, tree }, observations: new Map(),
    engine: { setupRuns: 0, results: [{ report: { summary: report } } as unknown as EngineResult] },
  } as unknown as RunContext;
  assert.deepEqual(await resolveSubject(ctx, 'fixtures.bothCollisionPaths'), { known: true, value: expected });
  const ignored = manifest.files.find((file) => file.rule !== 'duplicate-title')!;
  ignored.rule = 'duplicate-title';
  ignored.synced = false;
  tree.paths.set('outside/ignored.md', ignored.path);
  assert.deepEqual(await resolveSubject(ctx, 'fixtures.bothCollisionPaths'), { known: true, value: expected });
  const assertion = loadScenarios().find((scenario) => scenario.id === 'L1-13')!.checks.assertions.find((check) => check.subject === 'summary.collisionPaths')!;
  assert.deepEqual(await evaluateAssertion(ctx, assertion), { holds: true });
  // Missing partners and paths with a changed Unicode form must fail, naming both sides.
  const nfd = `${prefix}/cafe\u0301.md`;
  const quotedNfd = JSON.stringify(nfd).replace('\u0301', '\\u0301');
  report.collisionPaths = expected.filter((path) => path !== nfd);
  assert.deepEqual(await evaluateAssertion(ctx, assertion), { holds: false, reason: `same-as did not hold: missing ${quotedNfd}` });
  report.collisionPaths = [...report.collisionPaths, 'other/Guide.md'];
  assert.deepEqual(await evaluateAssertion(ctx, assertion), { holds: false, reason: `same-as did not hold: missing ${quotedNfd}; unexpected "other/Guide.md"` });
  report.collisionPaths = expected.map((path) => path.normalize('NFC'));
  assert.deepEqual(await evaluateAssertion(ctx, assertion), { holds: false, reason: `same-as did not hold: missing ${quotedNfd}` });
  report.collisionPaths = [...expected].reverse();
  const reordered = await evaluateAssertion(ctx, assertion);
  assert.equal(reordered.holds, false);
  if (!reordered.holds) assert.match(reordered.reason, /index 0: expected/);
  report.collisionPaths = [...expected, expected[0]!];
  const duplicated = await evaluateAssertion(ctx, assertion);
  assert.equal(duplicated.holds, false);
  if (!duplicated.holds) assert.match(duplicated.reason, /index 4: expected end of list/);
});

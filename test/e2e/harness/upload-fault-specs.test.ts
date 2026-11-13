// L5-11 (a failed upload, then a retry) and L5-12 (a missing LFS object next
// to an independent edit) with their live steps and assertions on fake
// services. The two faults need the live proxies, so they get stand-ins: the
// upload fault answers HTTP 500 to the first upload request the fault proxy
// would fail, chosen by the proxy's own matcher, and the missing object is an
// LFS pointer whose object no LFS server has.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import { lostEdits, waitsOnlyForUnreadable } from './checks.ts';
import type { RunContext } from './context.ts';
import { DOCUMENTS, runOnFakeServices } from './fake-services.ts';
import { isUploadOperation } from './fault-proxy.ts';
import { loadScenarios } from './spec.ts';
import { commitAsPerson } from './step-helpers.ts';
import { SUBJECTS, type View } from './subjects.ts';
import type { LinearDocument } from '../../../src/linear/index.ts';

const scenario = (id: string) => loadScenarios().find((s) => s.id === id)!;
const INVARIANTS = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9'];
type Report = Record<string, any>;

/** The scenario's own runs and I6's extra run, after setup. */
function runs(ctx: RunContext): { own: Report[]; extra: Report[] } {
  const end = ctx.observations.get('scenario.runsEnd') as number;
  const reports = ctx.engine.results.map((result) => result.report as Report);
  return { own: reports.slice(ctx.engine.setupRuns, end), extra: reports.slice(end) };
}

it('L5-11: the failed upload leaves the document as it was, and the retry writes it with the uploaded image', { timeout: 180_000 }, async (t) => {
  let armed = 0;
  let injected = 0;
  const outcomes = await runOnFakeServices(t, scenario('L5-11'), DOCUMENTS, {
    partialRuns: true,
    steps: {
      'fault.upload-error': async (ctx) => {
        armed = 1;
        ctx.engine.restores.push(async () => { armed = 0; });
      },
    },
    intercept: (url, init) => {
      if (armed === 0 || !url.endsWith('/graphql') || typeof init?.body !== 'string') return undefined;
      if (!isUploadOperation(String(JSON.parse(init.body).operationName))) return undefined;
      armed -= 1;
      injected += 1;
      return Response.json({ errors: [{ message: 'injected fault' }] }, { status: 500 });
    },
    inspect: async (ctx) => {
      const { own } = runs(ctx);
      const path = ctx.observations.get('target.path') as string;
      // The live report's shapes: the faulted run lists the document as failed, the retry as updated.
      assert.deepEqual(own[0]?.['sync'].failed.map((entry: { path: string }) => entry.path), [path]);
      assert.equal(own[0]?.['complete'], false);
      assert.deepEqual(own[1]?.['sync'].updated, [path]);
      assert.equal(own[1]?.['complete'], true);
    },
  });
  assert.equal(injected, 1, 'the upload fault failed the engine\'s upload request');
  const names = new Set(outcomes.map((outcome) => outcome.name));
  for (const name of [...INVARIANTS, 'runs.0.target.failed', 'runs.0.documents.brokenImageUrls', 'runs.1.documents.imageUploaded', 'runs.1.target.written']) assert.ok(names.has(name), `${name} ran`);
  for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome));
});

it('L5-12: a missing LFS object leaves its document out with the reason while the other edit syncs', { timeout: 180_000 }, async (t) => {
  const outcomes = await runOnFakeServices(t, scenario('L5-12'), DOCUMENTS, {
    steps: {
      'fault.missing-lfs-object': async (ctx) => {
        const image = ctx.observations.get('git.imagePath') as string;
        const oid = createHash('sha256').update(`missing ${ctx.names.runId}`).digest('hex');
        await commitAsPerson(ctx, new Map([[image, `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 42\n`]]), 'Update the diagram', true);
        ctx.observations.set('fault.missingLfsOid', oid);
      },
    },
    inspect: async (ctx) => {
      const { own, extra } = runs(ctx);
      const path = ctx.observations.get('target.path') as string;
      const image = ctx.observations.get('git.imagePath') as string;
      const leftOut = [{ path, rule: 'upload-unreadable', files: [image] }];
      assert.deepEqual(own[0]?.['sync'].leftOutAtWrite, leftOut);
      assert.equal(own[0]?.['sync'].updated.length, 1, 'the other edit is written');
      assert.notEqual(own[0]?.['sync'].updated[0], path);
      // The engine waits for the object on every run; I6's run reports the same leave-out and no write.
      assert.equal(own[0]?.['complete'], false);
      assert.equal(extra[0]?.['complete'], false);
      assert.deepEqual(extra[0]?.['sync'].leftOutAtWrite, leftOut);
      assert.equal(extra[0]?.['record'], null, 'I6\'s run records nothing');
    },
  });
  const names = new Set(outcomes.map((outcome) => outcome.name));
  for (const name of [...INVARIANTS, 'summary.leftOutRules', 'documents.otherChangesSynced']) assert.ok(names.has(name), `${name} ran`);
  for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome));
});

it('I6 accepts an incomplete run only while it waits for unreadable files the scenario already left out', () => {
  const before = new Map([['a.md', 'write: upload-unreadable'], ['b.md', 'write: upload-too-large'], ['c.md', 'lint: footnote']]);
  const report = (sync: Record<string, unknown>, code: unknown = null, rest: Record<string, unknown> = {}) => ({
    code,
    capture: { ok: true, heldRemovals: [] },
    pullRequest: { needed: false },
    sync: { failed: [], notAttempted: [], skipped: [], conflicts: [], stopped: null, leftOutAtWrite: [{ path: 'a.md', rule: 'upload-unreadable', files: ['a.png'] }], ...sync },
    ...rest,
  });
  assert.equal(waitsOnlyForUnreadable(report({}), before), true);
  assert.equal(waitsOnlyForUnreadable(report({}, null, { pullRequest: { holdMarks: { deferred: 0 } } }), before), true, 'hold marks all set');
  assert.equal(waitsOnlyForUnreadable(report({ skipped: [{ path: 'd.md', reason: 'conflict' }] }), before), false, 'a skipped write');
  assert.equal(waitsOnlyForUnreadable(report({ conflicts: ['d.md'] }), before), false, 'a conflict');
  assert.equal(waitsOnlyForUnreadable(report({}, null, { capture: { ok: true, heldRemovals: ['d.md'] } }), before), false, 'a held removal');
  assert.equal(waitsOnlyForUnreadable(report({}, null, { pullRequest: { code: 'merge-blocked' } }), before), false, 'a pull request code');
  assert.equal(waitsOnlyForUnreadable(report({}, null, { pullRequest: { holdMarks: { deferred: 2 } } }), before), false, 'hold marks still to set');
  assert.equal(waitsOnlyForUnreadable(report({}, null, { capture: null }), before), false, 'no capture');
  assert.equal(waitsOnlyForUnreadable(report({}, 'state-moved'), before), false, 'a code');
  assert.equal(waitsOnlyForUnreadable(report({ leftOutAtWrite: [] }), before), false, 'nothing it waits for');
  assert.equal(waitsOnlyForUnreadable(report({ failed: [{ path: 'd.md' }] }), before), false, 'a failed write');
  assert.equal(waitsOnlyForUnreadable(report({ notAttempted: ['d.md'] }), before), false, 'a write not reached');
  assert.equal(waitsOnlyForUnreadable(report({ stopped: { code: 'budget' } }), before), false, 'a stop');
  assert.equal(waitsOnlyForUnreadable(report({ leftOutAtWrite: [{ path: 'b.md', rule: 'upload-too-large', files: ['b.png'] }] }), before), false, 'another rule');
  assert.equal(waitsOnlyForUnreadable(report({ leftOutAtWrite: [{ path: 'd.md', rule: 'upload-unreadable', files: ['d.png'] }] }), before), false, 'a file the scenario had not left out');
  assert.equal(waitsOnlyForUnreadable(report({ leftOutAtWrite: [{ path: 'c.md', rule: 'upload-unreadable', files: ['c.png'] }] }), before), false, 'left out for another reason before');
  assert.equal(waitsOnlyForUnreadable(report({ leftOutAtWrite: [{ path: 'a.md', rule: 'upload-unreadable', files: [] }] }), before), false, 'no files named');
  assert.equal(waitsOnlyForUnreadable({ code: null, sync: null }, before), false, 'not a sync');
});

it('a git edit of a file left out on purpose must stay in git, and other edits must reach both sides', () => {
  const edits = [{ side: 'git', path: 'a.md', token: 'aaaaaa-001' }, { side: 'git', path: 'b.md', token: 'aaaaaa-002' }, { side: 'linear', path: 'a.md', token: 'aaaaaa-003' }];
  const ctx = { edits, observations: new Map() } as unknown as RunContext;
  const document = (content: string) => ({ content, trashed: false }) as LinearDocument;
  const sides = (a: string, b: string, linear: string) => ({
    files: new Map([['a.md', a], ['b.md', b]]),
    documents: new Map([['d', document(linear)]]),
    omitted: new Map([['a.md', 'write: upload-unreadable']]),
  });
  assert.deepEqual(lostEdits(ctx, sides('aaaaaa-001 aaaaaa-003', 'aaaaaa-002', 'aaaaaa-002 aaaaaa-003')), []);
  assert.deepEqual(lostEdits(ctx, sides('aaaaaa-003', 'aaaaaa-002', 'aaaaaa-002 aaaaaa-003')), [edits[0]], 'the left-out edit must stay in git');
  assert.deepEqual(lostEdits(ctx, sides('aaaaaa-001 aaaaaa-003', 'aaaaaa-002', 'aaaaaa-003')), [edits[1]], 'another file is still checked');
  assert.deepEqual(lostEdits(ctx, sides('aaaaaa-001', 'aaaaaa-002', 'aaaaaa-002')), [edits[2]], 'a Linear edit of the left-out file is still checked');
  // Without the omissions, as before: the left-out edit counts as lost.
  const { omitted: _omitted, ...plain } = sides('aaaaaa-001 aaaaaa-003', 'aaaaaa-002', 'aaaaaa-002 aaaaaa-003');
  assert.deepEqual(lostEdits(ctx, plain), [edits[0]]);
});

it('documents.brokenImageUrls counts image links that show no image', async () => {
  const cached = 'https://uploads.linear.test/cached.png';
  const view = (content: string, text = '# A\n\n![d](media/d.png)\n\n![o](https://example.com/o.png)\n\n![g](media/gone.png)\n') => ({
    files: new Map([['eng/a.md', text]]),
    ids: new Map([['eng/a.md', { id: 'd' }]]),
    documents: new Map([['d', { content, trashed: false }]]),
    uploadsByHash: new Map([['h', cached]]),
    hashes: new Map([['eng/a.md', 'x'], ['eng/media/d.png', 'h']]),
  }) as unknown as View;
  const count = (v: View) => SUBJECTS['documents.brokenImageUrls']!({ ctx: { observations: new Map() } as unknown as RunContext, which: 'now', view: async () => v } as never);
  // The upload, an outside image and a link git itself breaks show as written.
  assert.equal(await count(view(`# A\n\n![d](${cached})\n\n![o](https://example.com/o.png)\n\n![g](media/gone.png)\n`)), 0);
  // A link to a file of the tree that reached Linear as written, and an upload the cache does not hold.
  assert.equal(await count(view('# A\n\n![d](media/d.png)\n\n![x](https://uploads.linear.test/failed.png)\n')), 2);
  // The upload keeps the link's fragment after the asset URL.
  assert.equal(await count(view(`# A\n\n![d](${cached}#view)\n`, '# A\n\n![d](media/d.png#view)\n')), 0);
  // A plain link is not an image.
  assert.equal(await count(view('# A\n\n[d](media/d.png)\n')), 0);
});

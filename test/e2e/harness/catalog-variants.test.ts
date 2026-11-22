// The catalog's variations of L1-03, L1-04 and L1-15 (L1-21 to L1-23) and
// the API-path image gate (L2-42), with their live steps and assertions on
// fake services, through the harness's own step executors.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { RunContext } from './context.ts';
import { DOCUMENTS, runOnFakeServices } from './fake-services.ts';
import { commentsWithState, destinationKind, imageGateRecord, imagePlace, isImageNotice, noticeImageLabels, placeLabel, withoutImage, writtenImagePath } from './image-gate.ts';
import { renderRunMarkdown } from './report.ts';
import { resultOf } from './runner.ts';
import { INIT_FILES, initArguments, initRelease, withoutAnnotation } from './init-files.ts';
import { loadScenarios } from './spec.ts';
import { STEP_ACTIONS } from './steps.ts';
import { REQUIRED_SETUP_CHECKS, subjectSource } from './subjects.ts';
import { MINIMUM_RELEASE } from '../../../src/init/releases.ts';
import { IMAGE_BLOCKED_COMMENT } from '../../../src/sync/marks.ts';
import { fixText } from '../../../src/format/index.ts';
import { LinearClient } from '../../../src/linear/index.ts';

const scenario = (id: string) => {
  const found = loadScenarios().find((s) => s.id === id);
  assert.ok(found, `${id} is in the catalog`);
  return found;
};
const INVARIANTS = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9'] as const;

/** The documents as the corpus holds its files: already in Linear's form, which `golden.linearForm` compares against. */
const LINEAR_FORM = Object.fromEntries(Object.entries(DOCUMENTS).map(([path, text]) => [path, fixText(text)]));

/** Every outcome holds, and each of `names` was among them. */
function allHold(outcomes: Array<{ name: string; ok: boolean }>, names: readonly string[]): void {
  const ran = new Set(outcomes.map((outcome) => outcome.name));
  for (const name of names) assert.ok(ran.has(name), `${name} ran`);
  for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome));
}

describe('catalog specs', () => {
  it('every step of the new specs has an executor and every subject a source', () => {
    for (const id of ['L1-21', 'L1-22', 'L1-23', 'L2-42']) {
      const spec = scenario(id);
      assert.equal(spec.mode, 'local');
      for (const step of spec.steps) assert.ok(STEP_ACTIONS[`${step.kind}.${step.action}`], `${id}: ${step.kind}.${step.action} has an executor`);
      for (const assertion of spec.checks.assertions) {
        assert.notEqual(subjectSource(assertion.subject), null, `${id}: ${assertion.subject} has a source`);
        if (assertion.operator === 'same-as') assert.notEqual(subjectSource(String(assertion.expected)), null, `${id}: ${String(assertion.expected)} has a source`);
      }
    }
  });

  it('L1-21 is L1-04 on mini, walked as the documentation walks it, with the strict content comparison', () => {
    const spec = scenario('L1-21');
    const original = scenario('L1-04');
    assert.equal(spec.slice, 'mini');
    assert.deepEqual(spec.steps.map((step) => [step.action, step.args.confirm]), [['initial-sync', false], ['initial-sync', true], ['sync', undefined]]);
    assert.deepEqual(spec.checks.assertions, original.checks.assertions);
    for (const invariant of INVARIANTS) assert.equal(spec.checks.invariants[invariant]?.required, true);
  });

  it('L1-22 is two fresh confirmed runs on mid, the second writing nothing, with the strict content comparison', () => {
    const spec = scenario('L1-22');
    assert.equal(spec.slice, 'mid');
    assert.equal(spec.setup.state, 'empty');
    assert.deepEqual(spec.steps.map((step) => [step.kind, step.action, step.args.confirm]), [['run', 'initial-sync', true], ['run', 'initial-sync', true]]);
    assert.deepEqual(spec.checks.assertions.find((a) => a.subject === 'documents.content'), { subject: 'documents.content', operator: 'same-as', expected: 'golden.linearForm' });
    for (const invariant of INVARIANTS) assert.equal(spec.checks.invariants[invariant]?.required, true);
  });

  it('L1-23 keeps L1-03\'s dry-run assertions and invariants after init and a passing check as runs.0', () => {
    const spec = scenario('L1-23');
    const original = scenario('L1-03');
    assert.equal(spec.slice, 'mini');
    assert.deepEqual(spec.steps.map((step) => `${step.kind}.${step.action}`), ['git.init-files', 'run.check', 'run.initial-sync']);
    assert.deepEqual(spec.steps[2]?.args, original.steps[0]?.args);
    assert.deepEqual(spec.checks.invariants, original.checks.invariants);
    for (const assertion of original.checks.assertions) assert.ok(spec.checks.assertions.some((a) => JSON.stringify(a) === JSON.stringify(assertion)), `keeps ${assertion.subject}`);
  });
});

describe('the API-path image gate', () => {
  const body = '# Plan\n\n![](https://uploads.linear.app/a/b/one.png)\n\n```\n![not](an-image.png)\n```\n\nText x1.\n\n![plan x1](../images/plan-x1.png)\n';

  it('finds the written image by its alt text, its place among the images and its line', () => {
    assert.deepEqual(imagePlace(body, 'x1'), { image: 2, total: 2, line: 11, url: '../images/plan-x1.png' });
    assert.equal(placeLabel({ image: 2, total: 2, line: 11 }), 'Image 2 of 2 (line 11)');
    assert.equal(imagePlace(body, 'x2'), null);
    // Linear may turn the path into an upload of its own: the image is still found by its alt text.
    assert.equal(imagePlace(body.replace('../images/plan-x1.png', 'https://uploads.linear.app/c/d/plan.png'), 'x1')?.line, 11);
  });

  it('reads the image labels from the sync\'s notices only, and removes the image line for the fix', () => {
    const notice = `${IMAGE_BLOCKED_COMMENT}\n\n- Image 2 of 2 (line 11): not uploaded to this workspace. Upload the file instead of linking to it.`;
    assert.deepEqual(noticeImageLabels(['- Image 9 of 9 (line 1): someone wrote this', notice]), ['Image 2 of 2 (line 11)']);
    assert.equal(isImageNotice('A comment'), false);
    assert.equal(withoutImage(body, 'x1'), '# Plan\n\n![](https://uploads.linear.app/a/b/one.png)\n\n```\n![not](an-image.png)\n```\n\nText x1.\n');
    assert.equal(withoutImage('A\n\n\n\nB\n\n![plan x1](p.png)\n', 'x1'), 'A\n\n\n\nB\n', 'blank lines elsewhere keep their bytes');
    assert.equal(withoutImage(body, 'x2'), null);
  });

  it('names the kind of destination Linear stored, never the destination', () => {
    const written = writtenImagePath('x1');
    assert.equal(written, '../images/plan-x1.png');
    assert.equal(destinationKind(written, written), 'relative-path');
    assert.equal(destinationKind('https://uploads.linear.app/c/d/plan.png?signature=s', written), 'upload');
    // A path Linear changed or emptied is not the path kept.
    for (const other of ['images/plan-x1.png', '', '#', '/images/plan-x1.png', '//uploads.linear.app/c/d/plan.png', 'http://uploads.linear.app/c/d/plan.png', 'https://uploads.linear.app:8443/c/d/plan.png', 'https://example.com/plan.png', 'data:image/png;base64,AAAA']) {
      assert.equal(destinationKind(other, written), 'other', other);
    }
  });

  it('records an upload\'s HTTP status from the sync\'s own authenticated download, and keeps no URL', async () => {
    const signed = 'https://uploads.linear.app/c/d/plan.png?signature=secret-signature';
    const uploaded = body.replace('../images/plan-x1.png', signed);
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const answering = (answer: () => Response) => new LinearClient({ token: 'app-token', fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return answer();
    }) as typeof fetch });
    const dead = await imageGateRecord(answering(() => new Response('gone', { status: 404 })), uploaded, 'x1');
    assert.deepEqual(dead, { storedDestination: 'upload', uploadStatus: 404 });
    assert.doesNotMatch(JSON.stringify(dead), /uploads\.linear\.app|secret-signature/);
    // The request the sync's download makes: the app's token, no redirect followed.
    assert.equal(seen[0]?.url, signed);
    assert.equal(seen[0]?.init?.redirect, 'manual');
    assert.deepEqual(seen[0]?.init?.headers, { authorization: 'Bearer app-token' });
    assert.deepEqual(await imageGateRecord(answering(() => new Response('png', { status: 200 })), uploaded, 'x1'), { storedDestination: 'upload', uploadStatus: 200 });
    assert.deepEqual(await imageGateRecord(answering(() => { throw new Error(`fetch failed for ${signed}`); }), uploaded, 'x1'), { storedDestination: 'upload', uploadStatus: null });
    // A kept path or another destination is not fetched.
    seen.length = 0;
    assert.deepEqual(await imageGateRecord(answering(() => new Response('', { status: 500 })), body, 'x1'), { storedDestination: 'relative-path' });
    assert.deepEqual(await imageGateRecord(answering(() => new Response('', { status: 500 })), body.replace('../images/plan-x1.png', 'https://example.com/plan.png'), 'x1'), { storedDestination: 'other' });
    assert.equal(await imageGateRecord(answering(() => new Response('', { status: 500 })), body, 'x2'), null);
    assert.equal(seen.length, 0);
  });

  it('the run report shows the stored destination and the upload status', () => {
    const base = { level: 'L2', slice: 'mini', mode: 'local', result: 'pass' as const, startedAt: '', durationMs: 0, engineRequests: 0, harnessRequests: 0, harnessAppRequests: 0, budgetWaitMs: 0, checks: [], cleanup: { ok: true } };
    const report = (results: Parameters<typeof renderRunMarkdown>[0]['results']) => renderRunMarkdown({ harnessRunId: 'r', startedAt: '', finishedAt: '', host: 'test', selection: {}, results });
    const markdown = report([
      { ...base, id: 'L2-42', runId: 'a1b2c3', imageGate: { storedDestination: 'upload', uploadStatus: 404 } },
      { ...base, id: 'L2-42', runId: 'd4e5f6', imageGate: { storedDestination: 'relative-path' } },
      { ...base, id: 'L2-42', runId: '0a0b0c', imageGate: { storedDestination: 'upload', uploadStatus: null } },
      { ...base, id: 'L1-01', runId: '111111' },
    ]);
    assert.match(markdown, /## Image gate/);
    assert.match(markdown, /\| L2-42 \| a1b2c3 \| upload \| 404 \|/);
    assert.match(markdown, /\| L2-42 \| d4e5f6 \| relative-path \| n\/a \|/);
    assert.match(markdown, /\| L2-42 \| 0a0b0c \| upload \| request failed \|/);
    assert.doesNotMatch(markdown, /\| L1-01 \| 111111 \| (upload|relative-path|other) \|/);
    assert.doesNotMatch(report([{ ...base, id: 'L1-01', runId: '111111' }]), /Image gate/);
  });

  it('L2-42: a valid upload reaches git while a path image becomes a reviewed link written back after merge', { timeout: 240_000 }, async (t) => {
    const outcomes = await runOnFakeServices(t, scenario('L2-42'), DOCUMENTS, {
      inspect: async (ctx: RunContext) => {
        const source = ctx.observations.get('imageRepair.source') as { path: string; line: number };
        assert.notEqual(source.path, (ctx.observations.get('linear.image') as { path: string }).path, 'the upload and the path go into two documents');
        assert.ok(source.line > 0);
        const notices = (await commentsWithState(ctx.live!.app, ctx.observations.get('target.id') as string)).filter((comment) => isImageNotice(comment.body));
        assert.deepEqual(notices, [], 'the valid upload got no image notice');
        assert.deepEqual(resultOf(ctx, { result: 'pass' }, { startedAt: 0, budgetWaitMs: 0, checks: [], cleanup: { ok: true } }).imageGate, { storedDestination: 'relative-path' });
      },
    });
    allHold(outcomes, [...INVARIANTS, ...scenario('L2-42').checks.assertions.map(assertion => assertion.subject)]);
  });

  for (const status of [404, 410]) it(`L2-42: an upload answering ${status} becomes a reviewed link and reaches Linear after merge`, { timeout: 240_000 }, async (t) => {
    const dead = 'https://uploads.linear.app/fake-workspace/plan-dead.png';
    let downloads = 0;
    const outcomes = await runOnFakeServices(t, scenario('L2-42'), DOCUMENTS, {
      intercept: (url, init) => {
        if (typeof init?.body === 'string' && /\.\.\/images\/plan-/.test(init.body)) init.body = init.body.replace(/\.\.\/images\/plan-[a-z0-9-]+\.png/g, dead);
        if (url === dead) {
          downloads += 1;
          return new Response('', { status });
        }
        return undefined;
      },
      inspect: async (ctx: RunContext) => {
        assert.deepEqual(ctx.observations.get('imageGate.record'), { storedDestination: 'upload', uploadStatus: status });
        const result = resultOf(ctx, { result: 'pass' }, { startedAt: 0, budgetWaitMs: 0, checks: [], cleanup: { ok: true } });
        assert.deepEqual(result.imageGate, { storedDestination: 'upload', uploadStatus: status });
        assert.doesNotMatch(JSON.stringify(result), /fake-workspace/, 'the result keeps no upload URL');
      },
    });
    assert.ok(downloads >= 2, 'the sync and the harness both requested the upload');
    allHold(outcomes, [...INVARIANTS, ...scenario('L2-42').checks.assertions.map(assertion => assertion.subject)]);
  });

  // Live L2-42 showed two things the plain fake does not: Linear stores a link destination in angle brackets,
  // and the repaired document also holds an image of the repository that Linear holds as an upload.
  it('L2-42: the repaired link is written as Linear stores it, beside an uploaded image of the repository', { timeout: 240_000 }, async (t) => {
    const dead = 'https://uploads.linear.app/fake-workspace/plan-dead.png';
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==', 'base64');
    const documents = { ...DOCUMENTS, 'eng/notes/images/logo.png': png, 'eng/notes/item-1.md': '# Notes 1\n\n![Logo](images/logo.png)\n\nFirst paragraph.\n\nSecond paragraph.\n' };
    const linked = /(?<![!\\])\[([^\]]*)\]\((https:\/\/[^\s()<>]+)\)/g;
    const writtenBack: string[] = [];
    const outcomes = await runOnFakeServices(t, scenario('L2-42'), documents, {
      intercept: (url, init) => {
        if (typeof init?.body === 'string' && /\.\.\/images\/plan-/.test(init.body)) init.body = init.body.replace(/\.\.\/images\/plan-[a-z0-9-]+\.png/g, dead);
        if (url === dead) return new Response('', { status: 404 });
        if (!url.endsWith('/graphql') || typeof init?.body !== 'string') return undefined;
        const body = JSON.parse(init.body) as { variables?: { input?: { content?: string } } };
        const input = body.variables?.input;
        if (typeof input?.content === 'string' && input.content.includes(dead)) {
          writtenBack.push(input.content);
          // Linear's spelling: every inline link destination in angle brackets, image destinations bare.
          input.content = input.content.replace(linked, '[$1](<$2>)');
          init.body = JSON.stringify(body);
        }
        return undefined;
      },
      inspect: async (ctx: RunContext) => {
        const source = ctx.observations.get('imageRepair.source') as { path: string; body: string };
        const proposal = ctx.observations.get('imageRepair.proposal') as { recorded: string; proposed: string };
        assert.equal(source.path, 'eng/notes/item-1.md');
        assert.doesNotMatch(source.body, /images\/logo\.png/, 'Linear holds the logo as an upload');
        assert.match(proposal.recorded, /!\[Logo\]\(images\/logo\.png\)/, 'git holds the logo at its path');
        assert.ok(proposal.proposed.includes(`](<${dead}>)`), 'the proposal spells the link as Linear stores it');
      },
    });
    // The editor's own write holds the image with a bare destination; only the write-back holds the link.
    assert.ok(writtenBack.some(content => content.includes(`](<${dead}>)`) && !content.includes(`](${dead})`)), "the write-back sends the link in Linear's spelling");
    allHold(outcomes, [...INVARIANTS, ...scenario('L2-42').checks.assertions.map(assertion => assertion.subject)]);
  });

  it('L2-42 still blocks upload bytes that are HTML and clears the mark after correction, keeping its notice open', { timeout: 240_000 }, async (t) => {
    const invalid = 'https://uploads.linear.app/fake-workspace/invalid.png';
    const spec = scenario('L2-42');
    spec.steps[3] = {kind: 'linear', action: 'remove-image', args: {actor: 'editor-a'}};
    spec.checks.assertions = [
      {subject: 'tracked.uploadedImage', operator: 'equal', expected: true},
      {subject: 'blocked.icon', operator: 'equal', expected: 'Alert'},
      {subject: 'blocked.color', operator: 'equal', expected: 'red'},
      {subject: 'blocked.imageLines', operator: 'same-as', expected: 'expected.blockedImageLines'},
      {subject: 'blocked.openImageNotices', operator: 'equal', expected: 1},
      {subject: 'blocked.marksRestored', operator: 'equal', expected: true},
      {subject: 'tracked.body', operator: 'same-as', expected: 'linear.body'},
      {subject: 'pullRequests.lintFindings', operator: 'equal', expected: []},
    ];
    const outcomes = await runOnFakeServices(t, spec, DOCUMENTS, {
      intercept: (url, init) => {
        if (typeof init?.body === 'string' && /\.\.\/images\/plan-/.test(init.body)) init.body = init.body.replace(/\.\.\/images\/plan-[a-z0-9-]+\.png/g, invalid);
        return url === invalid ? new Response('<html>Not an image</html>', {headers: {'content-type': 'image/png'}}) : undefined;
      },
      inspect: async (ctx) => {
        const comments = ctx.observations.get('blocked.comments') as string[];
        assert.equal(comments.filter(isImageNotice).length, 1);
        assert.match(comments.find(isImageNotice)!, /the uploaded file is not a supported image or document/);
      },
    });
    allHold(outcomes, [...INVARIANTS, ...spec.checks.assertions.map(assertion => assertion.subject)]);
  });

  it('L2-42 rejects a write-back that leaves the original image in Linear', { timeout: 240_000 }, async (t) => {
    const outcomes = await runOnFakeServices(t, scenario('L2-42'), DOCUMENTS, {
      intercept: (_url, init) => {
        if (!_url.endsWith('/graphql') || typeof init?.body !== 'string') return undefined;
        const body = JSON.parse(init.body) as { operationName?: string; variables?: { input?: { content?: string } } };
        const input = body.variables?.input;
        if (body.operationName === 'UpdateDocument' && typeof input?.content === 'string') {
          input.content = input.content.replace(/(?<!!)\[plan ([a-z0-9-]+)\]/g, '![plan $1]');
          init.body = JSON.stringify(body);
        }
        return undefined;
      },
      inspect: async (ctx) => {
        for (const subject of ['observed-original', 'proposed-link', 'tracked-link', 'stored-link']) {
          const pairs = JSON.parse(readFileSync(join(ctx.runDir, `image-repair-${subject}.json`), 'utf8'));
          assert.equal(pairs.length, subject === 'observed-original' ? 2 : 1);
          if (subject === 'stored-link' || subject === 'proposed-link') {
            assert.equal(pairs.every((pair: { sameMarkdown: boolean }) => pair.sameMarkdown), subject === 'proposed-link', subject);
          }
        }
        const stored = JSON.parse(readFileSync(join(ctx.runDir, 'image-repair-stored-link.json'), 'utf8'))[0];
        assert.match(stored.expected, /\[plan /);
        assert.match(stored.actual, /!\[plan /);
      },
    });
    const outcome = (name: string) => outcomes.find(candidate => candidate.name === name);
    assert.equal(outcome('imageRepair.storedLink')?.ok, false, 'an ignored link write-back must fail');
    assert.equal(outcome('imageRepair.proposedLink')?.ok, true, 'the reviewed proposal still held the link');
    assert.equal(outcome('imageRepair.listedInPr')?.ok, true);
  });

  it('L2-42 rejects a proposal that retains the image or omits its position', { timeout: 240_000 }, async (t) => {
    const outcomes = await runOnFakeServices(t, scenario('L2-42'), DOCUMENTS, {
      steps: { 'linear.inspect-image-repair': async (ctx, args) => {
        await STEP_ACTIONS['linear.inspect-image-repair']!(ctx, args);
        const source = ctx.observations.get('imageRepair.source') as { body: string };
        const proposal = ctx.observations.get('imageRepair.proposal') as { proposed: string; description: string };
        ctx.observations.set('imageRepair.proposal', {...proposal, proposed: source.body, description: ''});
      } },
      inspect: async (ctx) => {
        const pair = JSON.parse(readFileSync(join(ctx.runDir, 'image-repair-proposed-link.json'), 'utf8'))[0];
        assert.equal(pair.sameMarkdown, false);
        assert.match(pair.actual, /!\[plan /);
        assert.doesNotMatch(pair.expected, /!\[plan /);
      },
    });
    const outcome = (name: string) => outcomes.find((candidate) => candidate.name === name);
    assert.equal(outcome('imageRepair.proposedLink')?.ok, false);
    assert.equal(outcome('imageRepair.listedInPr')?.ok, false);
    assert.equal(outcome('imageRepair.storedLink')?.ok, true, 'the genuine link write-back still completed');
    assert.equal(outcome('tracked.uploadedImage')?.ok, true, 'the valid upload in the other document still reached git');
  });

});

describe('git.init-files', () => {
  it('takes the annotation out of a README and keeps its body', () => {
    const readme = '---\nlinear-team: ENG\nlinear-project: Field notes\n---\n# Notes\n\nText.\n';
    assert.equal(withoutAnnotation(readme), '# Notes\n\nText.\n');
    assert.equal(withoutAnnotation('---\ntitle: Notes\nlinear-team: ENG\n---\nText.\n'), '---\ntitle: Notes\n---\nText.\n');
    assert.equal(withoutAnnotation('Text.\n'), 'Text.\n');
  });

  it('names no folder, and pins the release under test or the templates\' release', () => {
    assert.deepEqual(initArguments({ sha: 'a'.repeat(40) }), ['--release-sha', 'a'.repeat(40), '--no-security-hooks']);
    assert.deepEqual(initArguments({ sha: 'a'.repeat(40), version: 'v1.2.3' }), ['--release-sha', 'a'.repeat(40), '--release-version', 'v1.2.3', '--no-security-hooks']);
    assert.deepEqual(initRelease(undefined), { sha: MINIMUM_RELEASE.sha, version: MINIMUM_RELEASE.version });
    assert.deepEqual(initRelease('b'.repeat(40)), { sha: 'b'.repeat(40) });
  });

  it('L1-23: the person\'s init files pass the setup check as runs.0, then L1-03\'s dry run holds', { timeout: 240_000 }, async (t) => {
    let committed: string[] = [];
    const outcomes = await runOnFakeServices(t, scenario('L1-23'), DOCUMENTS, {
      inspect: async (ctx: RunContext) => {
        committed = ctx.observations.get('init.files') as string[];
        const git = await ctx.person();
        for (const path of INIT_FILES) assert.ok((await git.text(['show', `HEAD:${path}`])).length > 0, `${path} is committed`);
        assert.match(await git.text(['show', 'HEAD:eng/notes/README.md']), /^---\nlinear-team: ENG\nlinear-project: Field notes\n---/);
      },
    });
    allHold(outcomes, ['I3', 'I4', 'I5', 'I8', 'I9', 'runs.0.ok', 'runs.0.setupChecks.failed', 'runs.0.setupChecks.names', 'summary.plan.paths', 'summary.leftOut', 'writes.total', 'summary.canaryCount']);
    assert.deepEqual(committed, [...INIT_FILES, 'eng/notes/README.md']);
    assert.ok(REQUIRED_SETUP_CHECKS.length > 0);
  });
});

describe('the initial sync variations', () => {
  it('L1-21: the dry run, the confirmed run and a quiet sync leave Linear with the strict linear form', { timeout: 240_000 }, async (t) => {
    const outcomes = await runOnFakeServices(t, scenario('L1-21'), LINEAR_FORM);
    allHold(outcomes, [...INVARIANTS, 'documents.content', 'ids.paths', 'linear.commitCount', 'linear.parents', 'pullRequests.created']);
  });

  it('L1-22: a second fresh confirmed run writes nothing and Linear keeps the strict linear form', { timeout: 240_000 }, async (t) => {
    const outcomes = await runOnFakeServices(t, scenario('L1-22'), LINEAR_FORM);
    allHold(outcomes, [...INVARIANTS, 'runs.1.writes.linear', 'documents.content']);
  });
});

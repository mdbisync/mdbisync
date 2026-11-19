// L6-14: an external image a person types in Linear's editor becomes a
// reviewed link. The UI steps are stood in for on fake services; the harness
// steps between them, the checks and the record run as in a held run.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunContext } from './context.ts';
import { DOCUMENTS, runOnFakeServices } from './fake-services.ts';
import { findTypedImage, typedImage, type TypedImage } from './image-gate.ts';
import { runNames } from './isolation.ts';
import { renderRunMarkdown } from './report.ts';
import { resultOf } from './runner.ts';
import { loadScenarios, type Scenario } from './spec.ts';
import { documentId, targetPath } from './step-helpers.ts';
import { STEP_ACTIONS } from './steps.ts';
import { subjectSource } from './subjects.ts';
import { renderUiChecklist, uiValueSubjects } from './ui-checklist.ts';

const byId = (id: string): Scenario => {
  const found = loadScenarios().find((s) => s.id === id);
  assert.ok(found, `${id} is in the catalog`);
  return found;
};
const INVARIANTS = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9'] as const;
const URL = 'https://example.com/harbor-map.png';
const typingArgs = (scenario: Scenario) => scenario.steps.find((step) => step.action === 'type-external-image')!.args;

/**
 * Stand-ins for the UI steps: the typing is a write of editor-a that puts `stored` (the typed Markdown by default)
 * at the end of the target document, as the checklist names it; the last look records the link as seen.
 */
function uiSteps(stored?: (typed: TypedImage) => string) {
  return {
    'ui.verify-editor': async () => {},
    'ui.type-external-image': async (ctx: RunContext, args: Record<string, unknown>) => {
      const typed = typedImage(args, ctx.names.runId);
      const app = ctx.live!.editors['editor-a'];
      const id = await documentId(ctx, targetPath(ctx));
      const [document] = await app.getDocuments([id], { withContent: true });
      await app.updateDocument(id, { content: `${(document?.content ?? '').replace(/\n*$/, '\n')}\n${stored?.(typed) ?? typed.markdown}\n` });
    },
    'ui.inspect-typed-link': async (ctx: RunContext) => void ctx.observations.set('ui.linkShown', true),
  };
}

describe('L6-14: an external image typed in the editor', () => {
  it('holds for the typing, then waits for the saved image, syncs, inspects and settles before the last look', () => {
    const scenario = byId('L6-14');
    assert.deepEqual([scenario.slice, scenario.mode, scenario.setup], ['mini', 'ui', { state: 'converged', fixtures: ['mini'], teamZoneLock: true }]);
    assert.deepEqual(scenario.steps.map((step) => `${step.kind}.${step.action}`), [
      'ui.verify-editor', 'ui.type-external-image', 'linear.await-typed-image', 'run.sync', 'linear.inspect-image-repair', 'run.settle', 'ui.inspect-typed-link',
    ]);
    for (const step of scenario.steps) if (step.kind !== 'ui') assert.ok(STEP_ACTIONS[`${step.kind}.${step.action}`], `${step.kind}.${step.action} has an executor`);
    for (const assertion of scenario.checks.assertions) assert.notEqual(subjectSource(assertion.subject), null, `${assertion.subject} has a source`);
    for (const invariant of INVARIANTS) assert.equal(scenario.checks.invariants[invariant]?.required, true);
    // The same repair checks as the API path (L2-42), without its upload, and the person's look at the link.
    const harness = scenario.checks.assertions.filter((assertion) => !assertion.subject.startsWith('ui.'));
    assert.deepEqual(harness, byId('L2-42').checks.assertions.filter((assertion) => assertion.subject !== 'tracked.uploadedImage'));
    assert.deepEqual(uiValueSubjects(scenario), ['ui.linkShown']);
  });

  it('gives the person the exact Markdown to type, with the run in its alt text, and names the target document', () => {
    const scenario = byId('L6-14');
    const checklist = renderUiChecklist(scenario, runNames('c0ffee'), { live: null, runDir: 'run' }, 'Notes 0');
    assert.match(checklist, /^- Target document \(the one the harness edits and checks\): "Notes 0"$/m);
    assert.match(checklist, /^2\. \[ \] As editor-a: Open the target document\. [^\n]*type, character by character \(do not paste\), exactly `!\[harbor map c0ffee\]\(https:\/\/example\.com\/harbor-map\.png\)`[^\n]*no "Leave site\?" prompt[^\n]*\n(?: {3}- [^\n]*\n){2}- \(harness\) linear\.await-typed-image: [^\n]*\n- \(harness\) run\.sync: [^\n]*\n- \(harness\) linear\.inspect-image-repair: [^\n]*\n- \(harness\) run\.settle: [^\n]*\n3\. \[ \] As editor-a: Reload the target document\. [^\n]*a link with the text "harbor map c0ffee" \(or the image's URL, if Linear kept no text for it\), not an image/m);
    assert.match(checklist, /^- `ui\.linkShown` expected equal `true`\n {2}- value:$/m);
  });

  it('accepts only a plain http(s) URL to type', () => {
    assert.deepEqual(typedImage({ imageUrl: URL }, 'abc123'), { alt: 'harbor map abc123', url: URL, markdown: `![harbor map abc123](${URL})` });
    for (const imageUrl of [undefined, '', 'example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AA', 'https://example.com/a b.png', 'https://example.com/a).png', 'https://example.com/<a>.png', 'https://example.com/a\\.png',
      'https://example.com/a.png?a=1&amp;b=2', 'https://example.com/a`.png', 'https://example.com/[a].png', 'https://example.com/"a".png', "https://example.com/'a'.png"]) {
      assert.throws(() => typedImage({ imageUrl }, 'abc123'), /needs an imageUrl that matches/, String(imageUrl));
    }
  });

  it('names what Linear stored for the typed image, finding it by URL or else by alt text', () => {
    const typed = typedImage({ imageUrl: URL }, 'abc123');
    const before = '# Notes\n\n![Logo](https://uploads.linear.app/c/d/logo.png)\n\nFirst paragraph.';
    assert.deepEqual(findTypedImage(`${before}\n\n${typed.markdown}`, typed, 1), { stored: 'external', place: { image: 2, total: 2, line: 7, offset: before.length + 2, inline: true } });
    // Linear's editor may drop or change the alt text: the URL still finds it.
    assert.equal(findTypedImage(`${before}\n\n![](${URL})`, typed, 1)?.stored, 'external');
    assert.equal(findTypedImage(`${before}\n\n![harbor map abc123](https://uploads.linear.app/c/d/copy.png)`, typed, 1)?.stored, 'upload');
    assert.equal(findTypedImage(`${before}\n\n![harbor map abc123](https://cdn.example.org/copy.png)`, typed, 1)?.stored, 'other-image');
    // An upload without the alt text: the image beyond those the document had, at its end, is the typed one.
    assert.deepEqual(findTypedImage(`${before}\n\n![](https://uploads.linear.app/c/d/copy.png)`, typed, 1), { stored: 'upload', place: { image: 2, total: 2, line: 7, offset: before.length + 2, inline: true } });
    // A reference-style image is found, and is not inline.
    assert.equal(findTypedImage(`${before}\n\n![harbor map abc123][1]\n\n[1]: ${URL}`, typed, 1)?.place?.inline, false);
    for (const text of [`[harbor map abc123](<${URL}>)`, `!\\[harbor map abc123\\](${URL})`, `See ${URL}`]) {
      assert.deepEqual(findTypedImage(`${before}\n\n${text}`, typed, 1), { stored: 'not-an-image' }, text);
    }
    // Neither the image nor its URL or alt text, nor a new image: Linear has not saved the typing yet.
    assert.equal(findTypedImage(before, typed, 1), null);
    assert.equal(findTypedImage(`${before}\n\n![harbor map abc124](${URL.replace('harbor', 'other')})`, typed, 2), null);
  });

  it('the run report shows what Linear stored for the typed image', () => {
    const base = { level: 'L6', slice: 'mini', mode: 'ui', result: 'pass' as const, startedAt: '', durationMs: 0, engineRequests: 0, harnessRequests: 0, harnessAppRequests: 0, budgetWaitMs: 0, checks: [], cleanup: { ok: true } };
    const markdown = renderRunMarkdown({ harnessRunId: 'r', startedAt: '', finishedAt: '', host: 'test', selection: {}, results: [
      { ...base, id: 'L6-14', runId: 'a1b2c3', typedImage: { stored: 'external' } },
      { ...base, id: 'L6-14', runId: 'd4e5f6', typedImage: { stored: 'not-an-image' } },
      { ...base, id: 'L1-01', runId: '111111' },
    ] });
    assert.match(markdown, /## Typed image/);
    assert.match(markdown, /\| L6-14 \| a1b2c3 \| external \|/);
    assert.match(markdown, /\| L6-14 \| d4e5f6 \| not-an-image \|/);
    assert.doesNotMatch(markdown, /## Image gate/);
  });

  it('an image Linear kept without its alt text becomes a link with its URL as the text', { timeout: 240_000 }, async (t) => {
    const scenario = byId('L6-14');
    const outcomes = await runOnFakeServices(t, scenario, DOCUMENTS, {
      steps: uiSteps((typed) => `![](${typed.url})`),
      inspect: async (ctx: RunContext) => {
        assert.deepEqual(ctx.observations.get('typedImage.record'), { stored: 'external' });
        const source = ctx.observations.get('imageRepair.source') as { expected: string };
        assert.ok(source.expected.includes(`[${URL}](${URL})`) && !source.expected.includes('!['));
      },
    });
    const ran = new Set(outcomes.map((outcome) => outcome.name));
    for (const name of [...INVARIANTS, ...scenario.checks.assertions.map((assertion) => assertion.subject)]) assert.ok(ran.has(name), `${name} ran`);
    for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome));
  });

  it('the typed image becomes a link in the sync pull request, reaches Linear after the merge, and the next run finds no change', { timeout: 240_000 }, async (t) => {
    const scenario = byId('L6-14');
    const outcomes = await runOnFakeServices(t, scenario, DOCUMENTS, {
      steps: uiSteps(),
      inspect: async (ctx: RunContext) => {
        assert.deepEqual(ctx.observations.get('typedImage.record'), { stored: 'external' });
        const source = ctx.observations.get('imageRepair.source') as { path: string; body: string; expected: string };
        assert.equal(source.path, targetPath(ctx));
        assert.ok(source.body.includes(`![harbor map aaaaaa](${URL})`));
        assert.ok(source.expected.includes(`[harbor map aaaaaa](${URL})`) && !source.expected.includes('![harbor map'));
        const result = resultOf(ctx, { result: 'pass' }, { startedAt: 0, budgetWaitMs: 0, checks: [], cleanup: { ok: true } });
        assert.deepEqual(result.typedImage, { stored: 'external' });
        // The image-gate record speaks of an API-written path only.
        assert.equal(result.imageGate, undefined);
      },
    });
    const ran = new Set(outcomes.map((outcome) => outcome.name));
    for (const name of [...INVARIANTS, ...scenario.checks.assertions.map((assertion) => assertion.subject)]) assert.ok(ran.has(name), `${name} ran`);
    for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome));
  });

  for (const [stored, form, write] of [
    ['upload', 'with the alt text', (typed: TypedImage) => `![${typed.alt}](https://uploads.linear.app/fake-workspace/copy.png)`],
    ['upload', 'without the alt text', () => '![](https://uploads.linear.app/fake-workspace/copy.png)'],
    ['not-an-image', 'a link', (typed: TypedImage) => `[${typed.alt}](${typed.url})`],
    ['not-observed', 'nothing of the typing', () => 'A sentence.'],
  ] as const) it(`records Linear storing the typed image as ${stored} (${form}), and checks no repair it is not`, { timeout: 240_000 }, async (t) => {
    const scenario = byId('L6-14');
    // Bounded: the wait ends at its first read on fake services.
    const quick = { ...scenario, steps: scenario.steps.map((step) => step.action === 'await-typed-image' ? { ...step, args: { ...step.args, timeoutSeconds: 0 } } : step) };
    let record: unknown;
    let source: unknown;
    const wait = async (ctx: RunContext, args: Record<string, unknown>) => {
      try {
        await STEP_ACTIONS['linear.await-typed-image']!(ctx, args);
      } finally {
        record = ctx.observations.get('typedImage.record');
        source = ctx.observations.get('imageRepair.source');
      }
    };
    await assert.rejects(runOnFakeServices(t, quick, DOCUMENTS, { steps: { ...uiSteps(write), 'linear.await-typed-image': wait } }), stored === 'not-observed' ? /held neither the typed image, its URL nor a new image 0 seconds after/ : new RegExp(`Linear stored the typed image as ${stored}, not as the external image typed`));
    // The result keeps what Linear stored, and the scenario does not go on to check a repair.
    assert.deepEqual(record, { stored });
    assert.equal(source, undefined);
  });
});

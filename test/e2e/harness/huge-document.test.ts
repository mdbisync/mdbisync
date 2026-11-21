// L5-22: a Linear document longer than the API accepts is captured. The API
// cannot make one, so the run holds for a person to paste the harness's text
// in the editor. The paste is stood in for on fake services by writing the
// document straight into the fake's store, past the client's length check, as
// the editor's own saving does; every harness step and check runs as live.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { LINEAR_FACTS } from '../../../src/linear/facts.ts';
import type { FakeWorld } from '../../../src/setup/test-helpers.ts';
import { validateScenario } from '../../scenarios/schema.ts';
import type { RunContext } from './context.ts';
import { DOCUMENTS, runOnFakeServices } from './fake-services.ts';
import { HUGE_DOCUMENT_FILE, hugeDocument, hugeDocumentRecord, hugeDocumentShortfall } from './huge-document.ts';
import { runNames } from './isolation.ts';
import { resultOf } from './runner.ts';
import { loadScenarios, type Scenario } from './spec.ts';
import { STEP_ACTIONS } from './steps.ts';
import { subjectSource } from './subjects.ts';
import { renderUiChecklist, uiFiles, uiValueSubjects } from './ui-checklist.ts';

const LIMIT = LINEAR_FACTS.maxContentLength;
const INVARIANTS = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9'] as const;
const scenario = (): Scenario => {
  const found = loadScenarios().find((s) => s.id === 'L5-22');
  assert.ok(found, 'L5-22 is in the catalog');
  return found;
};
const creating = (s: Scenario) => s.steps.find((step) => step.action === 'create-huge-document')!.args;
const raw = () => JSON.parse(readFileSync(new URL('../../scenarios/L5-22.yaml', import.meta.url), 'utf8')) as { steps: Array<{ kind: string; action: string; args: Record<string, unknown> }> };

/** Stand-ins for the UI steps: the paste stores `content(prepared text)` under the prepared title in the run's first project. */
function pasted(world: () => FakeWorld, content: (text: string) => string = (text) => text) {
  return {
    'ui.verify-editor': async () => {},
    'ui.create-huge-document': async (ctx: RunContext, args: Record<string, unknown>) => {
      const huge = hugeDocument(args, ctx.names.runId);
      const project = [...ctx.live!.projects.values()][0]!;
      const documents = world().linear.documents;
      documents.push({ id: `pasted-${documents.length + 1}`, title: huge.title, projectId: project.id, createdAt: new Date().toISOString(), content: world().linear.store(content(huge.text)) });
    },
  };
}

/** The scenario with a short wait, so a precondition that is not met ends the run at once. */
const quick = (s: Scenario, timeoutSeconds: number): Scenario => ({ ...s, steps: s.steps.map((step) => step.action === 'await-huge-document' ? { ...step, args: { ...step.args, timeoutSeconds } } : step) });

describe('L5-22: a document over the API limit, pasted in the editor', () => {
  it('holds for the paste, then reads the pasted document and settles; its checks are the capture and the warning', () => {
    const s = scenario();
    assert.deepEqual([s.slice, s.mode, s.setup], ['mini', 'ui', { state: 'converged', fixtures: ['mini'], teamZoneLock: true }]);
    assert.deepEqual(s.steps.map((step) => `${step.kind}.${step.action}`), ['ui.verify-editor', 'ui.create-huge-document', 'linear.await-huge-document', 'run.settle']);
    assert.equal(creating(s).characters, 260_000);
    for (const step of s.steps) if (step.kind !== 'ui') assert.ok(STEP_ACTIONS[`${step.kind}.${step.action}`], `${step.kind}.${step.action} has an executor`);
    for (const assertion of s.checks.assertions) assert.notEqual(subjectSource(assertion.subject), null, `${assertion.subject} has a source`);
    for (const invariant of INVARIANTS) assert.equal(s.checks.invariants[invariant]?.required, true);
    assert.deepEqual(s.checks.assertions.map((a) => [a.subject, a.operator, a.expected]), [
      ['tracked.body', 'same-as', 'linear.body'],
      ['runs.0.capture.writeBackWarnings.0.code', 'equal', 'linear-content-too-large-to-write-back'],
    ]);
    assert.deepEqual(uiValueSubjects(s), []);
  });

  it('prepares the exact length in plain ASCII paragraphs, the same for the checklist and the harness', () => {
    const huge = hugeDocument({ characters: 260_000 }, 'c0ffee');
    assert.equal(huge.text.length, 260_000);
    assert.match(huge.text, /^[\x20-\x7e\n]+$/);
    assert.doesNotMatch(huge.text, /\s$/);
    assert.ok(huge.text.startsWith(`The review moved to the next morning, note ${huge.token}.\n\n`));
    assert.equal(huge.title, 'large-notes-c0ffee');
    assert.deepEqual(hugeDocument({ characters: 260_000 }, 'c0ffee'), huge);
    assert.notEqual(hugeDocument({ characters: 260_000 }, 'c0ffef').sha256, huge.sha256);
    // Every cut ends in a character an editor keeps.
    for (let characters = LIMIT + 1; characters < LIMIT + 50; characters += 1) {
      const text = hugeDocument({ characters }, 'c0ffee').text;
      assert.equal(text.length, characters);
      assert.doesNotMatch(text, /\s$/, String(characters));
    }
    for (const characters of [undefined, LIMIT, 1000, LIMIT + 0.5, '260000']) {
      assert.throws(() => hugeDocument({ characters }, 'c0ffee'), /over Linear's API limit of 250000/, String(characters));
    }
  });

  it('the spec refuses a pasted document the API could make', () => {
    for (const characters of [LIMIT, 1000]) {
      const spec = raw();
      spec.steps[1]!.args.characters = characters;
      assert.throws(() => validateScenario(spec, 'L5-22.yaml'), /must exceed Linear's API content limit/);
    }
    const spec = raw();
    delete spec.steps[1]!.args.characters;
    assert.throws(() => validateScenario(spec, 'L5-22.yaml'));
  });

  it('the checklist names the project, the exact title, the file with its size and sha256, and what passes', () => {
    const s = scenario();
    const huge = hugeDocument(creating(s), 'c0ffee');
    const live = { projects: new Map([['p1', { id: 'p1', name: 'Field notes c0ffee' }], ['p2', { id: 'p2', name: 'Other c0ffee' }]]) } as unknown as RunContext['live'];
    const checklist = renderUiChecklist(s, runNames('c0ffee'), { live, runDir: 'run' });
    assert.match(checklist, /^1\. \[ \] As editor-a: Check that the signed-in user is editor-a/m);
    const item = /^2\. \[ \] As editor-a: (.*)$/m.exec(checklist)?.[1] ?? '';
    assert.ok(item.startsWith('In project "Field notes c0ffee", create a new document titled exactly `large-notes-c0ffee`.'), item);
    assert.ok(item.includes(`the whole text of \`${HUGE_DOCUMENT_FILE}\` in the run folder (next to this checklist): 260000 characters of plain text, sha256 \`${huge.sha256}\``), item);
    assert.match(item, /Do not type it or paste it in parts\./);
    assert.match(item, /If you paste again, first delete the earlier attempt, so the project has one document with that title\./);
    // Whatever Linear kept, the person answers pass: the harness's length check decides, so a short document is env-blocked, not a product failure.
    assert.match(item, /Answer pass once the page has finished saving \(a reload raises no "Leave site\?" prompt\), whatever Linear kept: the harness then reads the document and checks that Linear stored more than 250,000 characters before it syncs/);
    assert.doesNotMatch(item, /answer fail/);
    assert.match(item, /Note after `observed:` whether the document still ends with the file's last line/);
    assert.match(checklist, /^- \(harness\) linear\.await-huge-document: [^\n]*\n- \(harness\) run\.settle: /m);
    assert.deepEqual([...uiFiles(s, 'c0ffee')], [[HUGE_DOCUMENT_FILE, huge.text]]);
    // Rendered before the run is set up (no projects yet), the item names no project it cannot know.
    const early = /^2\. \[ \] As editor-a: (.*)$/m.exec(renderUiChecklist(s, runNames('c0ffee'), { live: null, runDir: 'run' }))?.[1] ?? '';
    assert.ok(early.startsWith("In the run's first project (named once the run is set up), create a new document titled exactly `large-notes-c0ffee`."), early);
    assert.deepEqual([...uiFiles({ ...s, steps: s.steps.filter((step) => step.action !== 'create-huge-document') }, 'c0ffee')], []);
  });

  it('a stored document meets the precondition only over the limit and with the prepared text', () => {
    const huge = hugeDocument({ characters: 260_000 }, 'c0ffee');
    assert.equal(hugeDocumentShortfall(huge.text, huge), undefined);
    assert.equal(hugeDocumentShortfall(huge.text.slice(0, LIMIT), huge), 'Linear stored 250000 code points, not over the API limit of 250000');
    // Code points, as Linear counts: 125,001 emoji are 250,002 UTF-16 units but not over the limit.
    const emoji = `${huge.token} ${'\u{1F600}'.repeat(125_001)}`;
    assert.ok(emoji.length > LIMIT);
    assert.match(hugeDocumentShortfall(emoji, huge) ?? '', /^Linear stored 125014 code points, not over/);
    assert.equal(hugeDocumentShortfall('x'.repeat(LIMIT + 1), huge), 'Linear stored 250001 code points that are not the prepared text of 260000');
    // Text lost in the middle, the rest still over the limit and still ending with the last line: not the document asked for.
    assert.equal(hugeDocumentShortfall(huge.text.slice(0, 100_000) + huge.text.slice(105_000), huge), 'Linear stored 255000 code points that are not the prepared text of 260000');
    // Final whitespace is an editor's, not a loss.
    assert.equal(hugeDocumentShortfall(`${huge.text}\n`, huge), undefined);
    assert.deepEqual(hugeDocumentRecord(`${huge.text}\n`, huge), { prepared: 260_000, stored: 260_001, sameAsPrepared: true });
    assert.deepEqual(hugeDocumentRecord(huge.text.replace('Plain', 'plain'), huge), { prepared: 260_000, stored: 260_000, sameAsPrepared: false });
  });

  it('linear.create refuses a length the API refuses and names the UI step', async () => {
    const ctx = { live: { projects: new Map([['p1', { id: 'p1', name: 'Field notes' }]]), editors: {} }, names: runNames('c0ffee'), sequence: 0 } as unknown as RunContext;
    // The whole body counts, its first sentence and line breaks with the requested characters.
    await assert.rejects(STEP_ACTIONS['linear.create']!(ctx, { actor: 'editor-a', characters: LIMIT }), /linear\.create cannot write 250\d{3} characters: Linear's API refuses content over 250000; use ui\.create-huge-document/);
  });

  it('the pasted document is captured byte for byte, with the warning that Linear will not take it back', { timeout: 240_000 }, async (t) => {
    let world: FakeWorld | undefined;
    const outcomes = await runOnFakeServices(t, quick(scenario(), 60), DOCUMENTS, {
      prepare: (w) => { world = w; },
      steps: pasted(() => world!),
      inspect: async (ctx: RunContext) => {
        assert.deepEqual(ctx.observations.get('hugeDocument.record'), { prepared: 260_000, stored: 260_000, sameAsPrepared: true });
        assert.deepEqual(resultOf(ctx, { result: 'pass' }, { startedAt: 0, budgetWaitMs: 0, checks: [], cleanup: { ok: true } }).hugeDocument, { prepared: 260_000, stored: 260_000, sameAsPrepared: true });
        assert.equal(ctx.observations.get('target.path'), 'eng/notes/large-notes-aaaaaa.md');
      },
    });
    const ran = new Set(outcomes.map((outcome) => outcome.name));
    for (const name of [...INVARIANTS, ...scenario().checks.assertions.map((assertion) => assertion.subject)]) assert.ok(ran.has(name), `${name} ran`);
    for (const outcome of outcomes) assert.equal(outcome.ok, true, JSON.stringify(outcome));
  });

  // A wait of one second reads the document twice (the default poll is five seconds), so a saved text is told from one still changing.
  for (const [what, content, timeoutSeconds, message] of [
    ['cut to the limit', (text: string) => text.slice(0, LIMIT), 1, /precondition not met: Linear stored 250000 code points, not over the API limit of 250000/],
    ['cut in the middle, still over the limit', (text: string) => text.slice(0, 100_000) + text.slice(105_000), 1, /precondition not met: Linear stored 255000 code points that are not the prepared text of 260000/],
    ['saved twice, under one title', 'twice', 1, /precondition not met: project "[^"]+" has 2 documents titled large-notes-aaaaaa/],
    ['still saving', 'once', 0, /precondition not met: Linear's saved document was still changing 0 seconds after the UI session answered/],
    ['never saved', undefined, 0, /precondition not met: no document titled large-notes-aaaaaa in project "[^"]+" 0 seconds after the UI session answered/],
  ] as const) it(`a paste Linear ${what} leaves the precondition unmet, with no shorter stand-in`, { timeout: 240_000 }, async (t) => {
    let world: FakeWorld | undefined;
    const paste = pasted(() => world!, typeof content === 'function' ? content : undefined);
    const steps = content === undefined
      ? { 'ui.verify-editor': async () => {}, 'ui.create-huge-document': async () => {} }
      : content === 'twice'
        ? { ...paste, 'ui.create-huge-document': async (ctx: RunContext, args: Record<string, unknown>) => { await paste['ui.create-huge-document'](ctx, args); await paste['ui.create-huge-document'](ctx, args); } }
        : paste;
    await assert.rejects(runOnFakeServices(t, quick(scenario(), timeoutSeconds), DOCUMENTS, { prepare: (w) => { world = w; }, steps }), (error: Error) => {
      assert.equal(error.name, 'EnvBlockedError');
      assert.match(error.message, message);
      return true;
    });
  });
});

// UI steps cannot run here: they run in a browser session where editor-a and
// editor-b are signed in. When a scenario reaches its first UI step, the
// harness has done the setup and every step before it, keeps the run's
// branches and projects, and writes this checklist for the UI session. The
// session works through it in order, answers each item with pass or fail and
// an observation (never document content), writes the values the checks
// read, and hands the answers back with `cli.ts ui-result`: the harness runs
// the steps between the answered items, and once every item is answered it
// runs the checks, records the result and cleans up.

import type { RunContext } from './context.ts';
import type { RunNames } from './isolation.ts';
import type { Assertion, Scenario, Step } from './spec.ts';
import { LINK_PAIR, type LinkPairFixture } from './fixtures.ts';
import { typedImage } from './image-gate.ts';

/**
 * The typing window of the typing items: the session starts typing, answers the item at once and hands the answers
 * back while it types. Taking the run up can take a while (admission, locks, a git step), so the session keeps typing
 * until `ui-result` logs that the window started, then stops within the item's `durationSeconds`. The `run.settle`
 * that follows runs syncs for `typingSeconds` from that log line (more than `durationSeconds`, which the scenario
 * tests check), so the typing falls among the runs, and the settling runs after the window capture all of it.
 */
const TYPING_WINDOW = (a: Record<string, unknown>) => `As you start typing, answer this item pass and hand the answers back with \`ui-result\` at once, in the background. Keep typing until its log shows "running syncs for … seconds while the UI session types", then stop within ${String(a.durationSeconds ?? 60)} seconds: the sync runs go on longer than that. Answer the next item only once \`ui-result\` has finished.`;

const INSTRUCTIONS: Record<string, (args: Record<string, unknown>, runId: string) => string> = {
  'verify-editor': (a) => `Check that the signed-in user is ${String(a.actor)}; wait until the screen has been idle at least ${String(a.requireIdleSeconds)} seconds before any input.`,
  'inspect-rendering': (a) => `Open ${String(a.sampleCount ?? 'the')} documents of group "${String(a.group ?? 'any')}"${a.coverAllConstructs === true ? ' covering every construct' : ''}; check headings, lists, task boxes, quotes, code blocks with language labels, Mermaid blocks, tables (rows and columns), images loaded (naturalWidth > 0), attachment links, Unicode and emoji.`,
  'inspect-conflict': () => 'Open the conflicted document: the orange Alert icon shows in the list and the header, the comment from the sync is there, and each of the three markers is a yellow warning callout with an exclamation icon, with the two versions as ordinary text between them.',
  'inspect-blocked': () => 'Open the blocked document: the red exclamation mark (`Alert`) icon and the comment naming the hook and line are there. Note what you see for the values below that start with `ui.blocked`.',
  'inspect-cleared': () => 'Reload the document that was blocked: the red exclamation mark icon is gone from the project\'s resources, the breadcrumb and the header, and the comment from the sync is still open, as the record of the finding. Note what you see for the values below that end with `AfterFix`.',
  'inspect-suspended': () => 'Open the suspended document: the red exclamation mark (`Alert`) icon shows in the project\'s resources, the breadcrumb and the header; it has exactly one comment from the sync that names the check `format`, links to the check\'s run, and quotes the line of the check\'s annotation. Follow the link: it opens the GitHub Actions job `format` of that check. Note what you see for the values below that start with `ui.suspended`.',
  'inspect-released': () => 'Reload the document that was suspended: its own icon and color are back (as before the suspension), with no red exclamation mark in the project\'s resources, the breadcrumb or the header, and the comment from the sync shows as resolved. Note what you see for the values below that end with `AfterRelease`.',
  'resolve-markers': () => 'In the editor, delete the three marker callouts and one of the two versions; keep the other version.',
  'type-during-write': (a) => `Open the target document. The harness changes its first paragraph from git while you type; ${a.target === 'same-paragraph' ? 'type at the end of that first paragraph' : 'type at the end of its last paragraph'} (check in the page that the caret is there). ${TYPING_WINDOW(a)} Record any character that disappears${a.target === 'same-paragraph' ? ', and the values below that measure it' : ''}.`,
  'type-two-editors': (a) => `Have ${Array.isArray(a.actors) ? a.actors.join(' and ') : 'both editors'} open the target document and type in it. ${TYPING_WINDOW(a)} Record both texts.`,
  'paste-image': () => 'Paste a small image at the end of the target document and wait until it shows. Answer only once Linear has saved it: a reload raises no "Leave site?" prompt and shows the image (this has taken about three minutes). The harness then waits until Linear\'s saved document holds the image before it syncs.',
  // L6-14: the Markdown is typed, not pasted: typing is the one editor path known to leave an external image.
  'type-external-image': (a, runId) => `Open the target document. At its end, start a new paragraph and type, character by character (do not paste), exactly \`${typedImage(a, runId).markdown}\`, so that the editor turns it into an image. Answer only once Linear has saved it: a reload raises no "Leave site?" prompt. Note after \`observed:\` whether the editor shows an image, a broken image, a link or the text as typed. The harness then waits until Linear's saved document holds it before it syncs.`,
  'inspect-typed-link': (_a, runId) => `Reload the target document. Where you typed the image, it now shows a link with the text "harbor map ${runId}" (or the image's URL, if Linear kept no text for it), not an image, and the document has no red exclamation mark and no comment from the sync about images. Note what you see for the values below.`,
  'rename-trash-restore': (a) => `Rename the document to "${String(a.title ?? 'renamed')}", then move it to the trash and restore it.`,
  'follow-document-links': () => `Open the document "${LINK_PAIR.source}" in the project named above. It links the document "${LINK_PAIR.target}" twice: "the route notes" to the whole document, and "depot hours" to its heading "Depot hours" (\`#${LINK_PAIR.anchor}\`). In the document view, click each link, going back to "${LINK_PAIR.source}" between the clicks. Record in the values below whether each click opened "${LINK_PAIR.target}" (in place or in a new tab, with no "not found" page) and whether the second one scrolled to the heading. Answer pass once both links are clicked and recorded, whatever they did.`,
  'assert-dom': () => 'Check the page for the expected state below and describe what it shows.',
};

/** Report metrics of a typing measurement (L6-07) and the `ui.*` value the session records for each. */
export const TYPING_METRICS = { typingOutcome: 'ui.typingOutcome', lostCharacterCount: 'ui.lostCharacterCount', lossWindowMs: 'ui.lossWindowMs' } as const;

/** Values a UI step records for the harness's own subjects, besides the scenario's `ui.*` assertions. */
const RECORDS: Record<string, (args: Record<string, unknown>) => string[]> = {
  // tracked.bothEditorChangesPresent looks for each editor's text on the tracked branch.
  'type-two-editors': () => ['ui.typedTexts'],
  // Typing where the sync writes is measured, not asserted: the report keeps what the session saw.
  'type-during-write': (a) => (a.target === 'same-paragraph' ? Object.values(TYPING_METRICS) : []),
  // Whether the link with a heading anchor scrolled to the heading: recorded, not required (the link opening is).
  'follow-document-links': () => ['ui.anchorScrolls'],
};

/**
 * Whether an assertion compares a text a person typed out in the UI: a
 * `same-as` with a `ui.*` subject on either side. Such a comparison ignores
 * the final line breaks of both texts, since a page does not show them; the
 * checklist says so next to the value.
 */
export function comparesTypedText(assertion: Pick<Assertion, 'subject' | 'operator' | 'expected'>): boolean {
  return assertion.operator === 'same-as' && (assertion.subject.startsWith('ui.') || String(assertion.expected).startsWith('ui.'));
}

const FINAL_LINE_BREAKS = 'line breaks at the end of a text are ignored';

/** UI steps that act on the scenario's target document: their checklist names it. */
export const TARGET_UI_STEPS: ReadonlySet<string> = new Set(['type-during-write', 'type-two-editors', 'paste-image', 'type-external-image', 'inspect-typed-link', 'inspect-suspended', 'inspect-released']);

/** `runId`: the run the checklist is for; some steps name it in what the person types or looks for. */
export function describeUiStep(step: Step, runId: string): string {
  const render = INSTRUCTIONS[step.action];
  return render === undefined ? `${step.action} (no instruction yet)` : render(step.args, runId);
}

/** The `ui.*` values the scenario's checks read, in order: its assertions' subjects (both sides of `same-as`), then what its UI steps record. */
export function uiValueSubjects(scenario: Scenario): string[] {
  const subjects = scenario.checks.assertions
    .flatMap((assertion) => [assertion.subject, ...(assertion.operator === 'same-as' ? [String(assertion.expected)] : [])])
    .filter((subject) => subject.startsWith('ui.'));
  for (const step of scenario.steps) if (step.kind === 'ui') subjects.push(...(RECORDS[step.action]?.(step.args) ?? []));
  return [...new Set(subjects)];
}

/** `targetDocument`: the title in Linear of the scenario's target document, which the run knows once it is set up. */
export function renderUiChecklist(
  scenario: Scenario, names: RunNames, ctx: Pick<RunContext, 'live' | 'runDir'> & Partial<Pick<RunContext, 'observations'>>, targetDocument?: string,
): string {
  const projects = ctx.live === null ? [] : [...ctx.live.projects.values()].map((project) => project.name);
  const pair = ctx.observations?.get('fixture.linkPair') as LinkPairFixture | undefined;
  const lines = [
    `# UI checklist: ${scenario.id} (run ${names.runId})`,
    '',
    `- Projects: ${projects.length === 0 ? 'none' : projects.join(', ')}`,
    ...(pair === undefined ? [] : [`- "${LINK_PAIR.source}" and "${LINK_PAIR.target}" are in project ${pair.project}`]),
    ...(targetDocument === undefined ? [] : [`- Target document (the one the harness edits and checks): "${targetDocument}"`]),
    `- Team-zone documents start with: \`${names.teamZonePrefix}\``,
    `- The run's resources stay until this checklist is answered or for two hours, whichever comes first.`,
    '- Answer in this file: `pass` or `fail` after `result:`, what you saw after `observed:` (never document content), and a JSON value after each `value:`.',
    `- Hand the answers back with \`node test/e2e/harness/cli.ts ui-result ${ctx.runDir} <this file>\`. With the items before a harness step answered, the harness runs that step and keeps the run; answer the items after it, and the values, only once it ran. With every item answered, it runs the checks, records the result and cleans up. A \`fail\` ends the run there.`,
    '',
    '## Steps',
    '',
  ];
  let number = 0;
  for (const step of scenario.steps) {
    if (step.kind === 'ui') {
      number += 1;
      lines.push(`${number}. [ ] As ${String(step.args.actor ?? 'editor-a')}: ${describeUiStep(step, names.runId)}`, '   - result: pass | fail', '   - observed:');
    } else {
      lines.push(`- (harness) ${step.kind}.${step.action}: hand back the answers above with \`ui-result\`; the harness runs it, then go on.`);
    }
  }
  const values = uiValueSubjects(scenario);
  if (values.length > 0) {
    lines.push('', '## Values', '');
    for (const subject of values) {
      const assertion = scenario.checks.assertions.find((candidate) => candidate.subject === subject);
      const compared = scenario.checks.assertions.find((candidate) => candidate.operator === 'same-as' && candidate.expected === subject);
      lines.push(
        assertion !== undefined
          ? `- \`${subject}\` expected ${assertion.operator} \`${JSON.stringify(assertion.expected)}\`${comparesTypedText(assertion) ? `; ${FINAL_LINE_BREAKS}` : ''}`
          : compared !== undefined
            ? `- \`${subject}\` (compared with \`${compared.subject}\`; ${FINAL_LINE_BREAKS})`
            : `- \`${subject}\` (recorded for the harness's checks)`,
        '  - value:',
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

export interface UiItemAnswer {
  /** The item's number in the checklist, from 1. */
  number: number;
  /** Null while the item is not answered. */
  result: 'pass' | 'fail' | null;
  observed: string;
}

export interface UiAnswers {
  /** The scenario and run the checklist's heading names, null without a heading. */
  scenarioId: string | null;
  runId: string | null;
  items: UiItemAnswer[];
  /** `ui.*` subject → the value the session wrote; values not written yet are absent. */
  values: Map<string, unknown>;
}

/** Reads an answered checklist. A result that is neither pass nor fail, or a value that is not JSON, is an error. */
export function parseUiAnswers(text: string): UiAnswers {
  const items: UiItemAnswer[] = [];
  const values = new Map<string, unknown>();
  let item: UiItemAnswer | undefined;
  let subject: string | undefined;
  const title = /^# UI checklist: (\S+) \(run ([0-9a-f]{6})\)$/m.exec(text);
  for (const line of text.split(/\r?\n/)) {
    const heading = /^(\d+)\. \[[ xX]\] /.exec(line);
    if (heading !== null) {
      item = { number: Number(heading[1]), result: null, observed: '' };
      items.push(item);
      subject = undefined;
      continue;
    }
    const valueHeading = /^- `(ui\.[\w.]+)`/.exec(line);
    if (valueHeading !== null) {
      subject = valueHeading[1];
      item = undefined;
      continue;
    }
    if (/^\S/.test(line)) {
      item = undefined;
      subject = undefined;
      continue;
    }
    const field = /^\s+- (result|observed|value):(.*)$/.exec(line);
    if (field === null) continue;
    const name = field[1];
    const answer = (field[2] ?? '').trim();
    if (item !== undefined && name === 'result') {
      if (answer === 'pass' || answer === 'fail') item.result = answer;
      else if (answer !== '' && answer !== 'pass | fail') throw new Error(`item ${item.number}: the result is "${answer}", not pass or fail`);
    } else if (item !== undefined && name === 'observed') {
      item.observed = answer;
    } else if (subject !== undefined && name === 'value' && answer !== '') {
      try {
        values.set(subject, JSON.parse(answer));
      } catch {
        throw new Error(`${subject}: the value is not JSON: ${answer}`);
      }
    }
  }
  items.forEach((answer, index) => {
    if (answer.number !== index + 1) throw new Error(`the checklist's items are not numbered 1, 2, 3, …: item ${index + 1} is numbered ${answer.number}`);
  });
  return { scenarioId: title?.[1] ?? null, runId: title?.[2] ?? null, items, values };
}

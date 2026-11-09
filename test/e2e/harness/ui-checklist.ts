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
import type { Scenario, Step } from './spec.ts';

const INSTRUCTIONS: Record<string, (args: Record<string, unknown>) => string> = {
  'verify-editor': (a) => `Check that the signed-in user is ${String(a.actor)}; wait until the screen has been idle at least ${String(a.requireIdleSeconds)} seconds before any input.`,
  'inspect-rendering': (a) => `Open ${String(a.sampleCount ?? 'the')} documents of group "${String(a.group ?? 'any')}"${a.coverAllConstructs === true ? ' covering every construct' : ''}; check headings, lists, task boxes, quotes, code blocks with language labels, Mermaid blocks, tables (rows and columns), images loaded (naturalWidth > 0), attachment links, Unicode and emoji.`,
  'inspect-conflict': () => 'Open the conflicted document: the orange Alert icon shows in the list and the header, the comment from the sync is there, and the three marker paragraphs are bold.',
  'inspect-blocked': () => 'Open the blocked document: the red Cross icon and the comment naming the hook and line are there.',
  'resolve-markers': () => 'In the editor, delete the three marker paragraphs and one of the two versions; keep the other version.',
  'type-during-write': (a) => `Type into ${String(a.target ?? 'one paragraph')} for ${String(a.durationSeconds ?? 60)} seconds while the harness runs the sync; record any character that disappears.`,
  'type-two-editors': (a) => `Have ${Array.isArray(a.actors) ? a.actors.join(' and ') : 'both editors'} type in the same document during a run; record both texts.`,
  'paste-image': () => 'Paste a small image into the document and wait until it shows.',
  'rename-trash-restore': (a) => `Rename the document to "${String(a.title ?? 'renamed')}", then move it to the trash and restore it.`,
  'assert-dom': () => 'Check the page for the expected state below and describe what it shows.',
};

/** Values a UI step records for the harness's own subjects, besides the scenario's `ui.*` assertions. */
const RECORDS: Record<string, string[]> = {
  // tracked.bothEditorChangesPresent looks for each editor's text on the tracked branch.
  'type-two-editors': ['ui.typedTexts'],
};

export function describeUiStep(step: Step): string {
  const render = INSTRUCTIONS[step.action];
  return render === undefined ? `${step.action} (no instruction yet)` : render(step.args);
}

/** The `ui.*` values the scenario's checks read, in order: its assertions' subjects (both sides of `same-as`), then what its UI steps record. */
export function uiValueSubjects(scenario: Scenario): string[] {
  const subjects = scenario.checks.assertions
    .flatMap((assertion) => [assertion.subject, ...(assertion.operator === 'same-as' ? [String(assertion.expected)] : [])])
    .filter((subject) => subject.startsWith('ui.'));
  for (const step of scenario.steps) if (step.kind === 'ui') subjects.push(...(RECORDS[step.action] ?? []));
  return [...new Set(subjects)];
}

export function renderUiChecklist(scenario: Scenario, names: RunNames, ctx: Pick<RunContext, 'live' | 'runDir'>): string {
  const projects = ctx.live === null ? [] : [...ctx.live.projects.values()].map((project) => project.name);
  const lines = [
    `# UI checklist: ${scenario.id} (run ${names.runId})`,
    '',
    `- Projects: ${projects.length === 0 ? 'none' : projects.join(', ')}`,
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
      lines.push(`${number}. [ ] As ${String(step.args.actor ?? 'editor-a')}: ${describeUiStep(step)}`, '   - result: pass | fail', '   - observed:');
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
          ? `- \`${subject}\` expected ${assertion.operator} \`${JSON.stringify(assertion.expected)}\``
          : compared !== undefined
            ? `- \`${subject}\` (compared with \`${compared.subject}\`)`
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

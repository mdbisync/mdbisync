// UI steps cannot run here: they run in a browser session where editor-a and
// editor-b are signed in. When a scenario reaches its first UI step, the
// harness has done the setup and every step before it, keeps the run's
// branches and projects, and writes this checklist for the UI session. The
// session works through it in order, answers each item with pass or fail and
// an observation (never document content), and reports back.

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

export function describeUiStep(step: Step): string {
  const render = INSTRUCTIONS[step.action];
  return render === undefined ? `${step.action} (no instruction yet)` : render(step.args);
}

export function renderUiChecklist(scenario: Scenario, names: RunNames, ctx: Pick<RunContext, 'live'>): string {
  const projects = ctx.live === null ? [] : [...ctx.live.projects.values()].map((project) => project.name);
  const lines = [
    `# UI checklist: ${scenario.id} (run ${names.runId})`,
    '',
    `- Projects: ${projects.length === 0 ? 'none' : projects.join(', ')}`,
    `- Team-zone documents start with: \`${names.teamZonePrefix}\``,
    `- The run's resources stay until this checklist is answered or for two hours, whichever comes first.`,
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
      lines.push(`- (harness) ${step.kind}.${step.action}: ask the harness to run it, then go on.`);
    }
  }
  const expectations = scenario.checks.assertions.filter((assertion) => assertion.subject.startsWith('ui.'));
  if (expectations.length > 0) {
    lines.push('', '## Expected', '');
    for (const assertion of expectations) lines.push(`- \`${assertion.subject}\` ${assertion.operator} \`${JSON.stringify(assertion.expected)}\``);
  }
  return `${lines.join('\n')}\n`;
}

// Scenario fixtures: what setup prepares beyond the slice, and how a step's
// `fixture` argument shapes its edit.
//
// - Document fixtures (conflict scenarios on a converged `mini`) add one
//   review document with paragraphs, a table, a code fence, lists and a
//   Mermaid fence to the tracked branch before the initial sync, so both
//   sides can edit the same or different parts of it.
// - State fixtures change the converged world after the initial sync: a
//   document with its own icon and color, a trashed document, a blocked one.
// - Slice fixtures only name content the slice already has; they need no setup.

import { CANARY_FILE, CANARY_TOKEN_OBSERVER_FILE, CANARY_TOKEN_OBSERVER, CANARY_FIXTURE, CANARY_KEY_ENV, canaryScript } from './security-canary.ts';
import { parse, stringify } from 'yaml';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { findFrontMatter } from '../../../src/mapping/front-matter.ts';
import { appendParagraph, editBlock, editParagraph, noteSentence, scanMarkers, ordinalOf, splitBlocks, joinBlocks, paragraphIndexes } from './conflicts.ts';
import type { LiveWorld, RunContext } from './context.ts';
import { pullTracked } from './person-git.ts';
import { CHECK_MARKER } from '../../corpus/check-workflow.ts';
import { recordPendingHead } from './check-fault.ts';
import { EnvBlockedError, ProductError } from './results.ts';
import { commitAsPerson, documentId, documentPaths, projectFolders, targetPath } from './step-helpers.ts';
import type { Step } from './spec.ts';

// --- small binary helpers ---------------------------------------------------------

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A valid 2×2 PNG whose pixel colors come from `seed`, so each seed gives different bytes. */
export function seededPng(seed: string): Buffer {
  const color = createHash('sha256').update(seed).digest();
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // truecolor
  const row = Buffer.concat([Buffer.from([0]), color.subarray(0, 6)]);
  const pixels = Buffer.concat([row, Buffer.concat([Buffer.from([0]), color.subarray(6, 12)])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

export function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A fake secret the corpus's test security hook rejects (`TESTKEY-` and 24 hex characters). */
export function fakeSecret(): string {
  return `TESTKEY-${randomBytes(12).toString('hex')}`;
}

/** Titles that are not plain paths (L1R-05). */
export const UNSAFE_TITLES = ['notes/agenda: monday?', 'notes/plan*draft', '  notes/leading spaces', 'notes/back\\slash', 'notes/pipe | table'];

// --- the review document ------------------------------------------------------------

/** Where document fixtures put the review document, below the run's first project folder. */
export const REVIEW_NAME = 'guides/weekly-plan.md';

export const DOCUMENT_FIXTURES: ReadonlySet<string> = new Set([
  'different-paragraphs', 'same-paragraph', 'table', 'code-fence', 'ordered-and-nested-list', 'flat-bullet-list',
  'mermaid', 'adjacent-paragraphs', 'images-at-same-position', 'front-matter-change', 'marker-lookalikes', 'three-editors',
]);

/** The review document: plain paragraphs and one block of each structure a conflict can take in. */
export function reviewDocument(options: { lookalikes: boolean }): string {
  return [
    '---',
    'owner: planning',
    '---',
    '# Weekly review',
    '',
    'The first paragraph explains the plan for the week.',
    '',
    'The second paragraph lists the open questions.',
    '',
    'The third paragraph records the decisions.',
    '',
    '| Area | Owner | State |',
    '| -- | -- | -- |',
    '| Build | Ana | open |',
    '| Docs | Ben | done |',
    '',
    '```text',
    'step one',
    'step two',
    '```',
    '',
    '1. Prepare the agenda',
    '   1. Collect topics',
    '2. Send the invite',
    '',
    '- Book the room',
    '- Order lunch',
    '',
    '```mermaid',
    'flowchart LR',
    '  A --> B',
    '```',
    ...(options.lookalikes
      ? ['', 'How a conflict looks:', '', '```text', '**Sync conflict: git version**', 'one', '**Sync conflict: Linear version**', 'two', '**Sync conflict: end**', '```']
      : []),
    '',
  ].join('\n');
}

// --- setup fixtures ---------------------------------------------------------------------

export interface FixtureTools {
  runStep(ctx: RunContext, step: Step): Promise<void>;
}

export interface SetupFixture {
  /** After the tracked branch and projects exist, before the initial sync. */
  beforeSync?(ctx: RunContext, live: LiveWorld, tools: FixtureTools): Promise<void>;
  /** After the initial sync of a converged or conflicted start, before the setup's conflict. */
  afterSync?(ctx: RunContext, live: LiveWorld, tools: FixtureTools): Promise<void>;
}

async function addReviewDocument(ctx: RunContext): Promise<void> {
  if (ctx.observations.has('fixture.document')) return;
  if (!['converged', 'conflicted'].includes(ctx.scenario.setup.state)) return; // on an empty start the fixture names slice content
  const folder = projectFolders(ctx)[0]?.folder;
  if (folder === undefined) throw new EnvBlockedError('the slice has no project folder for the review document');
  const path = `${folder}/${REVIEW_NAME}`;
  await commitAsPerson(ctx, new Map([[path, reviewDocument({ lookalikes: ctx.scenario.setup.fixtures.includes('marker-lookalikes') })]]), 'Add the weekly review', true);
  ctx.observations.set('fixture.document', path);
}

/**
 * The setup conflict of a `conflicted` start: both sides edit the same
 * paragraph of the same document, and a sync marks the conflict. That run
 * writes the markers to Linear only; the runs after it push them to the sync
 * branch, open the sync pull request and merge it, as the cycle does for any
 * change from Linear. The scenario starts with the markers on both sides, so
 * its git steps find them on the tracked branch.
 */
export async function openSetupConflict(ctx: RunContext, tools: FixtureTools): Promise<void> {
  await tools.runStep(ctx, { kind: 'git', action: 'edit', args: { fixture: 'same-paragraph' } });
  await tools.runStep(ctx, { kind: 'linear', action: 'edit', args: { actor: 'editor-a', fixture: 'same-paragraph' } });
  await tools.runStep(ctx, { kind: 'run', action: 'sync', args: {} });
  await tools.runStep(ctx, { kind: 'run', action: 'settle', args: {} });
  const git = await ctx.person();
  await pullTracked(git, ctx);
  const path = targetPath(ctx);
  const file = join(git.dir, path);
  // A whole set of markers outside code fences: lookalikes in a fence are not the conflict.
  const reached = existsSync(file) && scanMarkers(readFileSync(file, 'utf8')).sets.some((set) => set.kinds.length === 3);
  if (!reached) throw new ProductError(`the setup conflict did not reach the tracked branch: ${path} holds no complete set of conflict markers after the runs settled`);
}

/** A document's own icon and color, which a conflict's mark must give back. */
export const OWN_MARK = { icon: 'Bug', color: '#5e6ad2' } as const;

/** Fixtures whose starting tree publishes the pull request check workflow. */
export const CHECK_WORKFLOW_FIXTURES: ReadonlySet<string> = new Set(['check-workflow', 'pending-check']);

/** The starting tree publishes the check workflow: a check fault needs it, or a fixture asks for it. */
export function publishesCheckWorkflow(scenario: { steps: readonly Step[]; setup: { fixtures: readonly string[] } }): boolean {
  return scenario.steps.some((step) => step.kind === 'fault' && step.action === 'checks') || scenario.setup.fixtures.some((fixture) => CHECK_WORKFLOW_FIXTURES.has(fixture));
}

export const SETUP_FIXTURES: Record<string, SetupFixture> = {
  [CANARY_FIXTURE]: {
    async beforeSync(ctx) {
      if (ctx.scenario.mode !== 'actions') throw new EnvBlockedError('The security canary needs Actions mode');
      const key = process.env[CANARY_KEY_ENV];
      if (!key) throw new EnvBlockedError(`${CANARY_KEY_ENV} must hold the known workflow hook key`);
      const git = await ctx.person();
      const config = parse(await git.text(['show', 'HEAD:.pre-commit-config.yaml'])) as { repos: unknown[] };
      config.repos.push({ repo: 'local', hooks: [{ id: 'security-canary', alias: 'security', name: 'Security canary', entry: `node ${CANARY_FILE}`, language: 'system', stages: ['pre-commit'], always_run: true, pass_filenames: false, verbose: true }] });
      await commitAsPerson(ctx, new Map([
        [CANARY_FILE, canaryScript(sha256(key))],
        [CANARY_TOKEN_OBSERVER_FILE, CANARY_TOKEN_OBSERVER],
        ['.pre-commit-config.yaml', stringify(config)],
      ]), 'Add the security canary', true);
    },
  },
  ...Object.fromEntries([...DOCUMENT_FIXTURES].map((name) => [name, { beforeSync: addReviewDocument }])),
  // Same-run merge scenarios. A starting tree has no pull request check
  // workflow unless the scenario has a `fault.checks` step or one of these
  // fixtures (CHECK_WORKFLOW_FIXTURES): `check-workflow` publishes it (the
  // fast-check case), and `pending-check` also holds its check pending with
  // a marker committed before the initial sync, so the converged start has
  // it. Both paths lie outside every annotated folder; nothing syncs them.
  'check-workflow': {},
  'pending-check': {
    async beforeSync(ctx) {
      // The check workflow keeps a head with this marker pending; `fault.checks` with `passed` removes it.
      // The push to the tracked branch starts a sleeping job too, which that fault cancels first.
      recordPendingHead(ctx, await commitAsPerson(ctx, new Map([[CHECK_MARKER, 'pending\n']]), 'Hold the pull request check', true));
    },
  },
  'custom-icon-color': {
    async afterSync(ctx, live) {
      const path = targetPath(ctx);
      const id = await documentId(ctx, path);
      await live.editors['editor-a'].updateDocument(id, { icon: OWN_MARK.icon, color: OWN_MARK.color });
      ctx.observations.set('beforeConflict.icon', OWN_MARK.icon);
      ctx.observations.set('beforeConflict.color', OWN_MARK.color);
    },
  },
  'trashed-document': {
    async afterSync(ctx, live) {
      const path = targetPath(ctx, 'second-document');
      const id = await documentId(ctx, path);
      await live.editors['editor-a'].trashDocument(id);
      ctx.observations.set('fixture.trashedDocument', { path, id });
    },
  },
  // L6-04: a document the security hook blocked, for the UI session to inspect.
  'security-blocked': {
    async afterSync(ctx, _live, tools) {
      await tools.runStep(ctx, { kind: 'linear', action: 'edit', args: { actor: 'editor-a', fixture: 'fake-secret' } });
      await tools.runStep(ctx, { kind: 'run', action: 'sync', args: {} });
    },
  },
};

/** Fixtures that name content of the slice (or of a UI session's own steps) and need no setup. */
export const SLICE_FIXTURES: ReadonlySet<string> = new Set([
  'mini', 'mid', 'full', 'bank', 'bank-rendered', 'realistic-rendered', 'front-matter', 'images-lfs-and-regular', 'shared-image-40-documents',
  'attachments-all-types', 'oversize-assets', 'tables', 'typography-and-scripts', 'document-links', 'lint-errors', 'title-collision',
  'markers-in-paragraphs-lists-tables-code', 'reverse-initial', 'unsafe-title-samples', 'many-conflicts', 'security-hook', 'fake-secret',
  'open-conflict', 'concurrent-edit', 'image-document', 'restorable-document',
  // Document fixtures on an empty start select the slice's own documents of that kind.
  ...DOCUMENT_FIXTURES,
]);

/**
 * Two documents for the link check in the browser (L6-12): the index links
 * the notes twice, once to the whole document and once to one of its
 * headings. No corpus document links one target both ways, so the step adds
 * its own pair. Paths are relative to the run's first project folder; the
 * titles in Linear are those paths without `.md`.
 */
export const LINK_PAIR = { source: 'guides/route-index', target: 'guides/route-notes', anchor: 'depot-hours' } as const;

/**
 * The pair's texts, keyed like `LINK_PAIR`, in Linear's form, as the
 * corpus files are written: links in angle brackets and no final newline,
 * which Linear drops, so I1 finds each file equal to its document. The
 * notes run longer than one browser window, with text after their "Depot
 * hours" heading too, so a link to that heading has somewhere to scroll.
 */
export function linkPairTexts(link: string): { source: string; target: string } {
  const target = [
    '# Route notes',
    'Planners build the routes the evening before and check them again at seven. A route that changes after seven goes to the shift lead, who tells the drivers at the morning briefing.',
    'Each route lists its stops in the order the van reaches them, with the time window the customer agreed to. Stops without a window go last, unless the planner moves them up to fill a gap.',
    'When a customer cancels before seven, the planner removes the stop and closes the gap. After seven the stop stays on the list, and the driver marks it as cancelled on arrival.',
    'Routes for the far villages start first, because their last stop is two hours from the depot. The planner keeps those vans to fewer stops, so a late ferry does not push the whole route into the evening.',
    'A new driver rides along with an experienced one for the first week. On the second week the new driver takes a short route alone, and the planner checks the times with them at the end of each day.',
    '## Loading order',
    'Vans load in the reverse order of their stops, so the first delivery sits nearest the doors. The loading team works from the printed route sheet, not from memory.',
    'Heavy boxes go on the floor along the walls, and fragile ones on the shelves above them. Cold boxes load last and travel in the insulated bags by the doors.',
    'A van leaves only when its lead loader has signed the sheet. If a box is missing, the loader notes it on the sheet and the planner calls the customer before the van reaches the stop.',
    'Returns ride in the crates at the back. The driver stacks them so they do not block the doors, and the evening team empties the crates before the next loading.',
    'Large orders for one customer load on a pallet of their own, wrapped and labelled with the stop number. The driver unloads the pallet with the lift at the back and takes the wrap back to the depot.',
    '## Checks before leaving',
    'Before a van leaves the yard, the driver walks around it once: tyres, lights, mirrors and the side doors. Anything that looks wrong goes on the defect card in the cab.',
    'A van with a defect card that names the brakes, the tyres or the lights stays in the yard until the workshop has seen it. The planner moves its stops to the spare van.',
    'Fuel is topped up on the way back, never on the way out, so the first stop is not late. Each van keeps its fuel card in the glove box with the route sheet.',
    'The driver checks that the scanner is charged and that the day\'s route has loaded on it. A scanner that shows the wrong day goes back to the desk before the van leaves.',
    '## Depot hours',
    'The depot opens at six and closes at eight. Late vans call the night desk.',
    'On Saturdays the depot opens at seven and closes at four, and only the weekend routes run. Sunday is closed, apart from the cold store, which the night desk checks twice a day.',
    'On public holidays the depot keeps Saturday hours. The planner posts the holiday routes a week ahead, on the board by the loading doors.',
    '## Night desk',
    'The night desk takes calls from late vans, from drivers who cannot finish a route and from customers who missed a delivery. It writes each call in the desk log for the morning team.',
    'A van that returns after eight parks in the outer yard. The driver hands the keys and the route sheet to the night desk and leaves the returns in the crate by the gate.',
  ].join('\n\n');
  const source = [
    '# Route index',
    `Start with [the route notes](<${link}>).`,
    `The [depot hours](<${link}#${LINK_PAIR.anchor}>) changed this week.`,
  ].join('\n\n');
  return { source, target };
}

/** What `ui.follow-document-links` records about the pair it added: tracked paths, the anchor, and the project that holds them. */
export type LinkPairFixture = { [K in keyof typeof LINK_PAIR]: string } & { project: string };

/**
 * Starting state some steps need that the slice does not have: a left-out
 * document to fix (L2-12), a folder of N documents to rename (L2-14) and two
 * documents linked by id (L6-12). Each is made before the initial sync, so
 * the converged start holds it.
 */
export const STEP_PREPARATION: Record<string, SetupFixture> = {
  'ui.follow-document-links': {
    async beforeSync(ctx) {
      const home = projectFolders(ctx)[0];
      if (home === undefined) throw new EnvBlockedError('the slice has no project folder');
      const { folder, project } = home;
      const source = `${folder}/${LINK_PAIR.source}.md`;
      const target = `${folder}/${LINK_PAIR.target}.md`;
      const texts = linkPairTexts(relative(source, target));
      await commitAsPerson(ctx, new Map([[target, texts.target], [source, texts.source]]), 'Add the route notes and their index', true);
      ctx.observations.set('fixture.linkPair', { source, target, anchor: LINK_PAIR.anchor, project } satisfies LinkPairFixture);
    },
  },
  'git.remove-footnote': {
    async beforeSync(ctx) {
      const folder = projectFolders(ctx)[0]?.folder;
      if (folder === undefined) throw new EnvBlockedError('the slice has no project folder');
      const path = `${folder}/guides/footnote-notes.md`;
      await commitAsPerson(ctx, new Map([[path, '# Notes with a footnote\n\nThe plan moved to Friday.[^1]\n\n[^1]: Agreed in the weekly review.\n']]), 'Add notes with a footnote', true);
      ctx.observations.set('fixture.leftOut', path);
    },
  },
  'git.move-folder': {
    async beforeSync(ctx) {
      const step = ctx.scenario.steps.find((candidate) => `${candidate.kind}.${candidate.action}` === 'git.move-folder');
      const count = Number(step?.args.documents ?? 50);
      const folder = projectFolders(ctx)[0]?.folder;
      if (folder === undefined) throw new EnvBlockedError('the slice has no project folder');
      const git = await ctx.person();
      await pullTracked(git, ctx);
      // Documents without relative links, so moving them breaks no link.
      const movable = documentPaths(ctx).filter((path) => !/\]\(\s*(?![a-z][a-z0-9+.-]*:|#)[^)\s]+/i.test(readFileSync(join(git.dir, path), 'utf8')));
      if (movable.length < count) throw new EnvBlockedError(`the slice has ${movable.length} documents without relative links, fewer than the ${count} to move`);
      const target = `${folder}/batch-notes`;
      const documents: string[] = [];
      for (const [index, path] of movable.slice(0, count).entries()) {
        const destination = `${target}/${String(index).padStart(3, '0')}-${path.split('/').pop() as string}`;
        mkdirSync(join(git.dir, target), { recursive: true });
        await git.run(['mv', path, destination]);
        documents.push(destination);
      }
      await git.run(['commit', '--quiet', '--no-verify', '-m', 'Gather the batch notes']);
      await git.run(['push', '--quiet', '--no-verify', 'origin', `HEAD:refs/heads/${ctx.names.trackedBranch}`]);
      ctx.ownCommits.push((await git.text(['rev-parse', 'HEAD'])).trim());
      ctx.observations.set('fixture.folder', { path: target, documents });
    },
  },
};

export async function prepareFixtures(ctx: RunContext, live: LiveWorld, phase: keyof SetupFixture, tools: FixtureTools): Promise<void> {
  for (const fixture of ctx.scenario.setup.fixtures) await SETUP_FIXTURES[fixture]?.[phase]?.(ctx, live, tools);
  const actions = new Set(ctx.scenario.steps.map((step) => `${step.kind}.${step.action}`));
  for (const [action, preparation] of Object.entries(STEP_PREPARATION)) if (actions.has(action)) await preparation[phase]?.(ctx, live, tools);
}

// --- edit fixtures ------------------------------------------------------------------------

export interface EditOutcome {
  text: string;
  /** Files a git edit adds in the same commit (path relative to the repository root). */
  files?: Map<string, Buffer>;
}

/** Marks a token as the edit's own, inside the block it changed. */
function tagged(line: string, token: string): string {
  return `${line.replace(/\s+$/, '')} ${token}`;
}

function changeTableRow(text: string, token: string): string | null {
  return editBlock(text, (_block, kind) => kind === 'table', (lines) => lines.map((line, index) => (index === 2 ? line.replace(/\|\s*$/, `${token} |`) : line)));
}

function changeFenceLine(text: string, language: string, token: string): string | null {
  return editBlock(text, (block, kind) => kind === 'fence' && block.startsWith(`\`\`\`${language}`), (lines) => lines.map((line, index) => (index === 1 ? tagged(line, token) : line)));
}

function changeFirstLine(text: string, kinds: ReadonlyArray<string>, token: string): string | null {
  return editBlock(text, (_block, kind) => kinds.includes(kind), (lines) => lines.map((line, index) => (index === 0 ? tagged(line, token) : line)));
}

function changeFrontMatter(text: string, token: string): string {
  return text.replace(/^---\nowner: [^\n]*\n---\n/, `---\nowner: planning ${token}\n---\n`);
}

function frontMatterOf(text: string): string | null {
  return findFrontMatter(text)?.yaml ?? null;
}

function insertAfterFirstParagraph(text: string, line: string): string {
  const { blocks, separators } = splitBlocks(text);
  const index = paragraphIndexes(text)[0];
  if (index === undefined) return appendParagraph(text, line);
  blocks.splice(index + 1, 0, line);
  separators.splice(index, 0, '\n\n');
  return joinBlocks(blocks, separators);
}

function relative(fromFile: string, toFile: string): string {
  const from = fromFile.split('/').slice(0, -1);
  const to = toFile.split('/');
  let common = 0;
  while (common < from.length && from[common] === to[common]) common += 1;
  return [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/');
}

/**
 * How an edit with this fixture changes the text, or null when the fixture
 * does not shape the edit (the step's own default applies).
 */
export async function fixtureEdit(ctx: RunContext, fixture: unknown, side: 'git' | 'linear', path: string, text: string, token: string): Promise<EditOutcome | null> {
  const ordinal = (n: number) => editParagraph(text, n, token);
  switch (fixture) {
    case 'different-paragraphs':
    case 'marker-lookalikes':
      return { text: ordinal(side === 'git' ? 0 : 2) };
    case 'same-paragraph':
      return { text: ordinal(1) };
    case 'adjacent-paragraphs':
      return { text: ordinal(side === 'git' ? 0 : 1) };
    case 'table':
      return { text: changeTableRow(text, token) ?? ordinal(1) };
    case 'code-fence':
      return { text: changeFenceLine(text, 'text', token) ?? ordinal(1) };
    case 'mermaid':
      return { text: changeFenceLine(text, 'mermaid', token) ?? ordinal(1) };
    case 'ordered-and-nested-list':
      return { text: changeFirstLine(text, ['ordered-list', 'nested-list'], token) ?? ordinal(1) };
    case 'flat-bullet-list':
      return { text: changeFirstLine(text, ['bullet-list'], token) ?? ordinal(1) };
    case 'front-matter-change': {
      if (side === 'git') {
        const changed = changeFrontMatter(ordinal(1), token);
        ctx.observations.set('edited.frontMatter', frontMatterOf(changed));
        return { text: changed };
      }
      return { text: ordinal(1) };
    }
    case 'images-at-same-position': {
      if (side === 'git') {
        const image = `${path.split('/').slice(0, -1).join('/')}/media/note-${token}.png`.replace(/^\//, '');
        return { text: insertAfterFirstParagraph(text, `![note ${token}](${relative(path, image)})`), files: new Map([[image, seededPng(token)]]) };
      }
      const world = ctx.live;
      if (world === null) throw new Error('a Linear image needs the live world');
      const upload = await world.editors['editor-a'].uploadFile({ filename: `note-${token}.png`, contentType: 'image/png', bytes: new Uint8Array(seededPng(token)) });
      return { text: insertAfterFirstParagraph(text, `![note ${token}](${upload.assetUrl})`) };
    }
    case 'three-editors':
      return null;
    case 'fake-secret': {
      const secret = fakeSecret();
      ctx.observations.set('secret.value', secret);
      ctx.observations.set('secret.path', path);
      return { text: editParagraph(text, 0, token).replace(noteSentence(token), `${noteSentence(token)} Access key ${secret}.`) };
    }
    default:
      return null;
  }
}

/** The default paragraph edit for an ordinal target (`first-paragraph` …), else a new paragraph at the end; the text keeps its final line ending. */
export function paragraphEdit(text: string, target: unknown, token: string): string {
  if (typeof target === 'string' && target.endsWith('paragraph')) return editParagraph(text, ordinalOf(target) ?? 0, token);
  return appendParagraph(text, noteSentence(token));
}

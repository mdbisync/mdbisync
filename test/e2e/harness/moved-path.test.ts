// L2-23 and L2-24 rename a document in Linear and expect the file at
// `project/<new title>.md`. Under a team selection the mini slice is only
// part of the corpus: with ENG alone, its first document sits at team level,
// where no moved path can read `project/…`. These tests build the real mini
// slice for every selection and check that each scenario's rename picks a
// project document and that its oracle tells a correct rename from a wrong
// one equally well under each selection.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCorpus } from '../../corpus/generate.ts';
import type { RunContext } from './context.ts';
import { annotatedFolders, buildRunTree, inheritedTeam, selectTeams } from './corpus.ts';
import { runNames } from './isolation.ts';
import { loadScenarios } from './spec.ts';
import { projectFolderOf, projectFolders, targetPath } from './step-helpers.ts';
import { movedPath } from './subjects.ts';

const corpus = buildCorpus('0'.repeat(40));
const readmes = new Map(corpus.files.filter((file) => file.path.endsWith('README.md')).map((file) => [file.path, file.content.toString('utf8')]));
const names = runNames('abc123');
const scenarios = loadScenarios();

/** The context a run of the mini slice has after setup, for the selected teams (all when none). */
function miniRun(teams?: readonly string[]): RunContext {
  const slice = { slice: 'mini' as const, paths: corpus.slices.mini };
  const tree = buildRunTree(teams === undefined ? slice : selectTeams(slice, readmes, teams), readmes, names);
  return { live: { tree, manifest: corpus.manifest }, observations: new Map() } as unknown as RunContext;
}

/** The team the corpus annotates for a folder of the run's tree. */
function teamOf(folder: string): string {
  const team = inheritedTeam(folder, annotatedFolders(readmes));
  assert.ok(team !== null, folder);
  return team;
}

for (const id of ['L2-23', 'L2-24']) {
  const scenario = scenarios.find((candidate) => candidate.id === id)!;
  const rename = scenario.steps.find((step) => step.kind === 'linear' && step.action === 'rename')!;
  const assertion = scenario.checks.assertions.find((item) => item.subject === 'tracked.movedPath')!;
  const title = String(rename.args.title);

  /** Whether the moved-path assertion holds for a document that started at `origin` and ended at `landed`. */
  const holds = (ctx: RunContext, origin: string, landed: string): boolean => {
    ctx.observations.set('target.path', origin);
    return movedPath(ctx, landed) === assertion.expected;
  };

  describe(`${id} under team selection`, () => {
    it('the default target under ENG alone is a team-level document, which no moved path can express', () => {
      const ctx = miniRun(['ENG']);
      const first = targetPath(ctx);
      assert.equal(projectFolderOf(ctx, first), undefined);
      assert.match(first, /^eng\/abc123\//);
      // The engine's correct rename of it keeps it at team level.
      assert.equal(holds(ctx, first, `eng/abc123/${title}.md`), false);
    });

    for (const teams of [undefined, ['ENG'], ['DOCS']]) {
      const label = teams === undefined ? 'every team' : `${teams.join(', ')} only`;

      it(`${label}: the rename targets a project document`, () => {
        const ctx = miniRun(teams);
        const origin = targetPath(ctx, rename.args.target);
        assert.notEqual(projectFolderOf(ctx, origin), undefined, origin);
      });

      it(`${label}: a rename in the document's own project passes, and every wrong place fails`, () => {
        const ctx = miniRun(teams);
        const origin = targetPath(ctx, rename.args.target);
        const own = projectFolderOf(ctx, origin)!;
        assert.equal(holds(ctx, origin, `${own}/${title}.md`), true);
        // The old path, or the right folder under another name, fails.
        assert.equal(holds(ctx, origin, origin), false);
        assert.equal(holds(ctx, origin, `${own}/${title}-2.md`), false);
        // The same title at team level fails.
        assert.equal(holds(ctx, origin, `${own.split('/')[0]}/abc123/${title}.md`), false);
        // The same title in any other project fails, also when the slice has several.
        for (const other of projectFolders(ctx).filter((folder) => folder.folder !== own)) {
          assert.equal(holds(ctx, origin, `${other.folder}/${title}.md`), false, other.folder);
        }
      });
    }

    it('the project document is the same one whichever team selection holds it', () => {
      const all = miniRun();
      const path = targetPath(all, rename.args.target);
      assert.equal(targetPath(miniRun([teamOf(projectFolderOf(all, path)!)]), rename.args.target), path);
    });
  });
}

describe('the project-document target', () => {
  it('ENG alone has a second project, so the wrong-project case is exercised', () => {
    assert.ok(projectFolders(miniRun(['ENG'])).length >= 2);
  });

  it('steps through the project documents by offset, never to a team-level one', () => {
    const ctx = miniRun(['ENG']);
    const picked = [0, 1, 2].map((offset) => targetPath(ctx, 'project-document', offset));
    for (const path of picked) assert.notEqual(projectFolderOf(ctx, path), undefined, path);
    assert.notEqual(picked[0], picked[1]);
    // With two project documents, the third offset wraps around to the first.
    assert.equal(picked[2], picked[0]);
  });
});

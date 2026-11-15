import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IdEntry } from '../state/index.ts';
import { pullRequestHarness } from './pull-request-test-helpers.ts';

describe('saved hold comment ownership', () => {
  const h = pullRequestHarness();
  for (const mismatch of ['document', 'author']) {
    for (const action of ['clear', 'update', 'repaint', 'recover']) {
      it(`rejects a forged ${mismatch} before a hold ${action}`, async () => {
        const path = 'eng/notes/plan.md';
        await h.suspendOne();
        const document = await h.documentOf(path);
        const other = await h.documentOf('combined/guide.md');
        const ids = JSON.parse(await h.show('refs/mdbisync/ids:ids.json')) as Record<string, IdEntry>;
        const entry = ids[path]!;
        const forgedId = '99999999-9999-4999-8999-999999999999';
        const comment = {
          documentContentId: `content-${mismatch === 'document' ? other.id : document.id}`,
          body: 'Please review this paragraph.', userId: mismatch === 'author' ? 'person-other' : 'integration-one',
        };
        h.world.linear.comments.set(forgedId, comment);
        entry.saved!.hold!.id = forgedId;
        entry.suspended!.noticeId = forgedId;
        if (action === 'recover') entry.saved!.hold!.posted = false;
        if (action === 'repaint') document.icon = ':book:';
        await h.editRef('refs/mdbisync/ids', 'ids.json', JSON.stringify(ids));
        if (action === 'clear') h.checksOn(await h.rev(h.SUSPENDED), h.PASSED);
        if (action === 'update') h.checksOn(await h.rev(h.SUSPENDED), [{ name: 'format', status: 'completed', conclusion: 'failure' }]);
        const before = structuredClone(comment);
        const icon = document.icon;
        const run = await h.sync();
        assert.equal(run.report.pullRequest?.holdMarks?.code, 'write-failed');
        assert.match(run.report.pullRequest?.holdMarks?.failure?.message ?? '', /identity does not match/);
        assert.deepEqual(comment, before);
        assert.equal(document.icon, icon);
        assert.deepEqual(run.writes.filter((write) => !write.includes(' ')), []);
      });
    }
  }
});

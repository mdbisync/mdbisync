// The suspended document's comment: what it says, what it quotes and what
// it leaves out. The lane scenarios (pull-request.test.ts) cover when it is
// posted, edited and resolved.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type CheckAnnotation } from '../pull-request/index.ts';
import { ANNOTATIONS_PER_CHECK, HOLD_FAILED, HOLD_FOOTER, HOLD_TIMED_OUT, documentRuns, holdComment, quotesDocument } from './hold.ts';

const RUN = 'https://github.test/owner/repo/runs/7';
const at = (line: number, message: string, title?: string): CheckAnnotation => ({ path: 'docs/a.md', line, message, ...(title === undefined ? {} : { title }) });

describe('the suspended comment', () => {
  it('names the check, links its run and lists its annotations on this file, one line each', () => {
    const body = holdComment([{ name: 'format', url: RUN }], [], new Map([['format', [at(12, 'Expected a blank line before the list.')]]]), '# A\n\nText.\n');
    assert.equal(body, `${HOLD_FAILED}\n\n- Check \`format\`: [run](${RUN})\n  - Line 12: Expected a blank line before the list.\n\n${HOLD_FOOTER}`);
  });

  it('puts the title first, cuts a long message to 200 characters on one line, and escapes Markdown', () => {
    const long = `First line\nsecond line ${'x'.repeat(300)}`;
    const body = holdComment([{ name: 'lint' }], [], new Map([['lint', [at(3, long, 'MD001'), at(4, 'See [here](https://example.test) and ![img](x) `code`')]]]), '');
    const lines = body.split('\n');
    const first = lines.find((line) => line.includes('Line 3')) as string;
    assert.match(first, /^ {2}- Line 3: MD001: First line second line x+…$/);
    assert.equal([...first.replace('  - Line 3: ', '')].length, 200);
    assert.ok(lines.includes('  - Line 4: See \\[here\\](https://example.test) and \\!\\[img\\](x) \\`code\\`'), body);
    // A check without a link is still named.
    assert.ok(lines.includes('- Check `lint`.'));
  });

  it('shows at most ten annotations per check and counts the rest', () => {
    const many = Array.from({ length: 13 }, (_, i) => at(i + 1, `Problem ${i}.`));
    const body = holdComment([{ name: 'lint', url: RUN }], [], new Map([['lint', many]]), '');
    assert.equal(body.split('\n').filter((line) => line.startsWith('  - Line')).length, ANNOTATIONS_PER_CHECK);
    assert.ok(body.includes('  - and 3 more.'));
  });

  it('leaves out a message that repeats twelve characters of the document, keeping its line and title', () => {
    const text = '# Keys\n\nThe   token is  abcdef0123456789 here.\n';
    const body = holdComment([{ name: 'secrets', url: RUN }], [], new Map([['secrets', [
      at(3, 'Found token is abcdef0123456789', 'Generic secret'),
      at(4, 'Found abcdef0123456789'),
      at(5, 'Short abcdef01 only'),
    ]]]), text);
    assert.ok(body.includes('  - Line 3: Generic secret'));
    assert.ok(body.includes('  - Line 4.'));
    assert.ok(body.includes('  - Line 5: Short abcdef01 only'));
    assert.doesNotMatch(body, /0123456789/);
  });

  it('compares quotes with white space collapsed', () => {
    const runs = documentRuns('one  two\n\nthree four five');
    assert.ok(quotesDocument('x one two three fo y', runs));
    assert.ok(!quotesDocument('one two thre', new Set(['something else'])));
    assert.ok(!quotesDocument('short', runs));
  });

  it('says when a check did not finish in time', () => {
    assert.equal(holdComment([], ['build'], new Map(), ''), `${HOLD_TIMED_OUT}\n\n- Check \`build\` did not finish in time.\n\n${HOLD_FOOTER}`);
    const both = holdComment([{ name: 'lint', url: RUN }], ['build'], new Map(), '');
    assert.ok(both.startsWith(HOLD_FAILED));
    assert.ok(both.includes('- Check `build` did not finish in time.'));
  });

  it('never lets a check name break out of its code span', () => {
    const body = holdComment([{ name: 'a`b\nc', url: RUN }], [], new Map(), '');
    assert.ok(body.includes('- Check `a b c`: [run]'));
  });
});

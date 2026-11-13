// The suspended document's comment: what it says, what it quotes and what
// it leaves out. The lane scenarios in pull-request-suspension.test.ts and
// pull-request-release.test.ts cover when it is posted, edited and resolved.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type CheckAnnotation } from '../pull-request/index.ts';
import { LinearGraphQLError, LinearHttpError, LinearNetworkError } from '../linear/index.ts';
import { ANNOTATIONS_PER_CHECK, HOLD_FAILED, HOLD_FOOTER, HOLD_TIMED_OUT, HOLD_UNNAMED, LINEAR_MESSAGE_LENGTH, MESSAGE_WITHHELD, documentRuns, holdComment, quotesDocument, writeFailure } from './hold.ts';

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

  it('encodes a run link so it cannot close the Markdown link or add an image', () => {
    const body = holdComment([{ name: 'ext', url: 'https://ci.test/x)![t](https://tracker.test/p.png' }], [], new Map(), '');
    assert.ok(body.includes('- Check `ext`: [run](https://ci.test/x%29%21%5Bt%5D%28https://tracker.test/p.png)'), body);
  });

  it('says the checks have not passed yet when it can name none', () => {
    assert.equal(holdComment([], [], new Map(), ''), `${HOLD_FAILED}\n\n- ${HOLD_UNNAMED}\n\n${HOLD_FOOTER}`);
  });

  it('never lets a check name break out of its code span', () => {
    const body = holdComment([{ name: 'a`b\nc', url: RUN }], [], new Map(), '');
    assert.ok(body.includes('- Check `a b c`: [run]'));
  });
});

describe('a failed mark or comment write', () => {
  const refusal = (message: string, code = 'INPUT_ERROR') => new LinearGraphQLError('UpdateDocument', 200, { message, extensions: { code } }, 'request-7');

  it("names the document, Linear's code, status, request and message", () => {
    assert.deepEqual(writeFailure(refusal('Argument Validation Error'), 'docs/a.md', undefined), {
      operation: 'UpdateDocument',
      path: 'docs/a.md',
      error: 'LinearGraphQLError INPUT_ERROR HTTP 200',
      code: 'INPUT_ERROR',
      status: 200,
      request: 'request-7',
      message: 'Argument Validation Error',
    });
  });

  it("keeps Linear's message on one line and cuts it", () => {
    const failure = writeFailure(refusal(`First\nsecond\u0007 ${'y'.repeat(400)}`), 'docs/a.md', undefined);
    assert.match(failure.message ?? '', /^First second y+…$/);
    assert.equal([...(failure.message ?? '')].length, LINEAR_MESSAGE_LENGTH);
  });

  it('withholds a message that repeats the comment the request sent', () => {
    const body = `${HOLD_FAILED}\n\n- Check \`lint\`\n\n${HOLD_FOOTER}`;
    const failure = writeFailure(new LinearGraphQLError('UpdateDocumentComment', 200, { message: `Variable "$input" got invalid value { body: "${body.slice(0, 40)}" }`, extensions: { code: 'INPUT_ERROR' } }), 'docs/a.md', body);
    assert.equal(failure.message, MESSAGE_WITHHELD);
    assert.equal(failure.code, 'INPUT_ERROR');
    assert.equal(writeFailure(new LinearGraphQLError('UpdateDocumentComment', 200, { message: 'Comment body is too long', extensions: { code: 'INPUT_ERROR' } }), 'docs/a.md', body).message, 'Comment body is too long');
  });

  it('finds an echo Linear JSON-escaped, and compares only when the failed request sent the comment', () => {
    const body = `${HOLD_FAILED}\n\n- Check \`lint\`\n  - Line 3: Rename my\\_file\\_a\\_b to the\\_new\\_name\n\n${HOLD_FOOTER}`;
    const escaped = JSON.stringify(body.slice(HOLD_FAILED.length, HOLD_FAILED.length + 80));
    const comment = new LinearGraphQLError('CommentOnDocument', 200, { message: `Variable "$input" got invalid value { body: ${escaped} }`, extensions: { code: 'INPUT_ERROR' } });
    assert.equal(writeFailure(comment, 'docs/a.md', body).message, MESSAGE_WITHHELD);
    // A mark write sent no comment: a phrase it shares with the comment is Linear's own text.
    assert.equal(writeFailure(refusal('Cannot change this document while it is archived'), 'docs/a.md', body).message, 'Cannot change this document while it is archived');
  });

  it('reports a comment write whose error has no message without one', () => {
    const silent = new LinearGraphQLError('CommentOnDocument', 200, { extensions: { code: 'INPUT_ERROR' } });
    assert.deepEqual(writeFailure(silent, 'docs/a.md', HOLD_FAILED), { operation: 'CommentOnDocument', path: 'docs/a.md', error: 'LinearGraphQLError INPUT_ERROR HTTP 200', code: 'INPUT_ERROR', status: 200 });
  });

  it('reports an HTTP failure or a lost request without a message', () => {
    assert.deepEqual(writeFailure(new LinearHttpError('ResolveComment', 502, 'request-8'), 'docs/a.md', undefined), { operation: 'ResolveComment', path: 'docs/a.md', error: 'LinearHttpError HTTP 502', status: 502, request: 'request-8' });
    assert.deepEqual(writeFailure(new LinearNetworkError('CommentOnDocument', new Error('reset')), 'docs/a.md', undefined), { operation: 'CommentOnDocument', path: 'docs/a.md', error: 'LinearNetworkError' });
  });
});

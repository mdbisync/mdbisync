import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'node:test';
import { outputCount, outputFile, outputText, reportText, writeReportFile } from './output.ts';

it('preserves Unicode Markdown and rejects binary controls and oversized output', () => {
  const text = '# Résumé 📝\n\n| Result | Count |\r\n| --- | --- |\n| Done | 2 |\n';
  assert.equal(outputText(text), text);
  for (const value of [null, {}, 'text\0tail', 'text\x1btail', 'text\x7ftail', 'text\x85tail']) assert.throws(() => outputText(value));
  assert.throws(() => outputText('12345', 4));
  assert.equal(outputText('', 0), '');
});

it('keeps reports usable when names contain control characters and preserves JSON data', () => {
  assert.equal(reportText('Name\x1b\x0b\x7f\x85\nNext'), 'Name\\u001b\\u000b\\u007f\\u0085\nNext');
  const record = { name: 'Plan\0\x85\nNext' };
  assert.deepEqual(JSON.parse(reportText(JSON.stringify(record))), record);
});

it('rejects invalid remote counts and output paths that escape their configured base', () => {
  for (const value of [-1, 0.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => outputCount(value));
  assert.equal(outputCount(42), 42);
  const base = join(tmpdir(), 'output-test');
  assert.equal(outputFile(base, 'summary.md'), resolve(base, 'summary.md'));
  for (const value of ['..', '../outside.json', base]) assert.throws(() => outputFile(base, value));
});

it('writes a report file without following links the checkout holds', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'report-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  const outside = join(root, 'outside');
  await mkdir(checkout);
  await mkdir(outside);
  await writeFile(join(outside, 'canary'), 'canary\n');

  // A normal write makes the missing directories and leaves no temporary file.
  await writeReportFile(join(checkout, 'out', 'nested', 'report.json'), '{}\n', checkout);
  assert.equal(await readFile(join(checkout, 'out', 'nested', 'report.json'), 'utf8'), '{}\n');
  assert.deepEqual(await readdir(join(checkout, 'out', 'nested')), ['report.json']);
  await writeReportFile(join(root, 'reports', 'report.json'), 'outside\n', checkout);
  assert.equal(await readFile(join(root, 'reports', 'report.json'), 'utf8'), 'outside\n');

  // A link at the file's name is replaced, not written through.
  await symlink(join(outside, 'canary'), join(checkout, 'out', 'summary.md'));
  await writeReportFile(join(checkout, 'out', 'summary.md'), 'summary\n', checkout);
  assert.equal(await readFile(join(outside, 'canary'), 'utf8'), 'canary\n');
  assert.ok((await lstat(join(checkout, 'out', 'summary.md'))).isFile());

  // A linked directory inside the checkout is refused: directly, with missing directories after it,
  // under an outside alias of the checkout, and as the target of an outside link.
  await symlink(outside, join(checkout, 'linked'));
  await symlink(checkout, join(root, 'alias'));
  await symlink(join(checkout, 'linked'), join(root, 'via'));
  for (const path of [
    join(checkout, 'linked', 'report.json'),
    join(checkout, 'linked', 'deeper', 'report.json'),
    join(root, 'alias', 'linked', 'report.json'),
    join(root, 'via', 'report.json'),
  ]) {
    await assert.rejects(writeReportFile(path, 'report\n', checkout), /is a symbolic link inside the checkout/, path);
  }
  assert.deepEqual(await readdir(outside), ['canary']);
  // A link outside the checkout, like a system's /tmp, is the runner's own.
  await writeReportFile(join(root, 'alias', 'out', 'report.json'), 'alias\n', checkout);
  assert.equal(await readFile(join(checkout, 'out', 'report.json'), 'utf8'), 'alias\n');
  // `..` after a link goes up from the link's target, as the file system takes it.
  await symlink(join(checkout, 'out', 'nested'), join(root, 'up'));
  await writeReportFile(`${root}/up/../up.json`, 'up\n', checkout);
  assert.equal(await readFile(join(checkout, 'out', 'up.json'), 'utf8'), 'up\n');

  // Off Windows a backslash is part of a name, not a separator.
  if (process.platform !== 'win32') {
    await writeReportFile(join(root, 'reports', 'a\\b.json'), 'slash\n', checkout);
    assert.equal(await readFile(join(root, 'reports', 'a\\b.json'), 'utf8'), 'slash\n');
  }

  // A regular file keeps its mode; the temporary name does not grow with the report's name.
  const kept = join(root, 'reports', `${'r'.repeat(240)}.json`);
  await writeFile(kept, 'old\n', { mode: 0o600 });
  await writeReportFile(kept, 'new\n', checkout);
  assert.equal(await readFile(kept, 'utf8'), 'new\n');
  assert.equal((await lstat(kept)).mode & 0o777, 0o600);

  // A directory or other special file at the name, a bare `..` and a loop of links are refused.
  await assert.rejects(writeReportFile(join(checkout, 'out', 'nested'), 'report\n', checkout), /is not a regular file/);
  await assert.rejects(writeReportFile(`${checkout}/out/..`, 'report\n', checkout), /is not a regular file/);
  await symlink(join(root, 'loop-b'), join(root, 'loop-a'));
  await symlink(join(root, 'loop-a'), join(root, 'loop-b'));
  await assert.rejects(writeReportFile(join(root, 'loop-a', 'report.json'), 'report\n', checkout), /too many symbolic links/);
});

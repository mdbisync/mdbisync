import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';
import type { RunContext } from './context.ts';
import { runStep } from './steps.ts';
import { offlineInput, parseFindings, runFormatCommand, writeInput } from './offline.ts';
import { BANK_DIR, loadBank } from '../../probe/bank.ts';
import { REPO_ROOT } from './engine.ts';

const root = mkdtempSync(join(tmpdir(), 'offline-assets-'));
after(() => rmSync(root, { recursive: true, force: true }));

it('fixes bank images to their recorded forms with their linked assets present', async () => {
  const observations = new Map<string, unknown>();
  const ctx = { live: null, runDir: root, observations } as RunContext;
  await runStep(ctx, { kind: 'run', action: 'fix', args: { input: 'bank' } });
  const output = observations.get('fix.output') as Map<string, string>;
  const golden = observations.get('golden.linearForm') as Map<string, string>;
  for (const file of ['images/inline-with-text.md', 'images/reference.md', 'images/spaces-in-path.md']) {
    assert.ok(golden.has(file));
    assert.equal(output.get(file), golden.get(file), file);
  }
  const input = observations.get('input.bytes') as Map<string, string>;
  assert.ok([...input.keys()].every((path) => path.endsWith('.md')));
  assert.equal(readFileSync(join(root, 'fix-input', 'assets/pixel.png')).subarray(1, 4).toString(), 'PNG');
});

it('writes byte-exact linked assets for bank and lint-error inputs without comparing them as Markdown', () => {
  const bank = loadBank(join(REPO_ROOT, BANK_DIR));
  for (const name of ['bank', 'lint-errors']) {
    const input = offlineInput(name);
    const required = name === 'bank' ? ['assets/pixel.png', 'assets/banner.png', 'assets/pixel copy.png', 'assets/summary.pdf'] : ['assets/banner.png'];
    for (const path of required) assert.ok(input.assets.has(path), `${name}: ${path}`);
    const dir = join(root, name);
    writeInput(dir, input.files, input.assets);
    for (const path of input.assets.keys()) {
      assert.deepEqual(readFileSync(join(dir, path)), readFileSync(join(bank.dir, path)), path);
      assert.ok(!input.files.has(path));
      assert.ok(!input.golden.has(path));
      assert.ok(!input.lintErrors.includes(path));
    }
  }
});

it('keeps corpus assets at their rewritten link destinations with their original bytes', () => {
  const input = offlineInput('full');
  assert.ok(input.assets.has('eng/platform/assets/status-icon.png'));
  const spaced = 'docs/reference/assets/pixel copy.png';
  assert.deepEqual(input.assets.get(spaced), readFileSync(join(REPO_ROOT, BANK_DIR, 'assets/pixel copy.png')));
  const dir = join(root, 'corpus');
  writeInput(dir, input.files, input.assets);
  for (const [path, content] of input.assets) {
    assert.deepEqual(readFileSync(join(dir, path)), content, path);
    assert.ok(!input.files.has(path));
    assert.ok(!input.golden.has(path));
  }
  const result = runFormatCommand('lint', dir);
  assert.ok([0, 1].includes(result.status ?? -1), result.stderr);
  const unexpectedMissing = parseFindings(result.stdout).filter((finding) => finding.rule === 'image-file-missing' && !input.lintErrors.includes(finding.file));
  assert.deepEqual(unexpectedMissing, [], 'all valid corpus images have their linked files');
});

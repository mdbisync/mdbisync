import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { fixLinearText, fixText, linkedFileResolver, sameMarkdown } from '../../src/format/index.ts';
import { goldenMarkdownPath, goldenYjsPath, loadBank } from './bank.ts';
import { readManifest } from './record.ts';

const bank = loadBank();
const manifest = readManifest(bank);

// These fixtures have completed their live recording. The general bank
// validator also permits fixtures still waiting for their first probe.
for (const name of ['audio-mp3', 'audio-mp3-numbered', 'audio-mp3-task', 'audio-wav', 'audio-ogg', 'audio-not-uploaded']) {
  test(`${name} has a complete fixed-point probe record`, () => {
    const file = `list-items/${name}.md`;
    assert.ok(bank.fixtures.some((fixture) => fixture.file === file), `${file} is indexed`);
    assert.deepEqual(manifest?.fixtures[file], { yjs: 'recorded', fixedPoint: true });
    const source = readFileSync(join(bank.dir, file), 'utf8');
    const recorded = readFileSync(join(bank.dir, goldenMarkdownPath(file)), 'utf8');
    assert.ok(readFileSync(join(bank.dir, goldenYjsPath(file))).length > 0, 'recorded Yjs exists');

    // The probe restores bank paths. Capture sees those paths after it
    // restores them too, but still gets the upload URLs in the raw content.
    const content = recorded.replaceAll('../assets/', 'https://uploads.example/');
    const linkedFileExists = linkedFileResolver(file, bank.dir);
    const hooked = fixText(source, { linkedFileExists });
    const captured = fixLinearText(recorded, content, linkedFileExists);
    assert.equal(hooked, captured, 'hook and capture write the same bytes');
    assert.ok(sameMarkdown(hooked, recorded), 'Linear readback makes no sync change');
    assert.equal(fixText(captured, { linkedFileExists }), captured, 'the hook leaves captured bytes alone');
  });
}

test('an encoded audio extension is recognized without changing the destination', () => {
  const file = 'list-items/audio-wav.md';
  const linkedFileExists = linkedFileResolver(file, bank.dir);
  const target = '../assets/clip.w%61v';
  assert.ok(linkedFileExists(target));
  const recorded = `* [Site visit recording](<${target}>)`;
  const hooked = fixText(`* \n  [Site visit recording](${target})`, { linkedFileExists });
  assert.equal(hooked, recorded);
  assert.equal(fixLinearText(recorded, '* [Site visit recording](<https://uploads.example/clip.wav>)', linkedFileExists), hooked);
});

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { goldenMarkdownPath, goldenYjsPath, loadBank, readOptional } from './bank.ts';
import { readManifest } from './record.ts';

const bank = loadBank();
const manifest = readManifest(bank);

// These fixtures have completed their live recording. The general bank
// validator also permits fixtures still waiting for their first probe.
for (const name of ['audio-mp3', 'audio-not-uploaded']) {
  test(`${name} has a complete fixed-point probe record`, () => {
    const file = `list-items/${name}.md`;
    assert.ok(bank.fixtures.some((fixture) => fixture.file === file), `${file} is indexed`);
    assert.deepEqual(manifest?.fixtures[file], { yjs: 'recorded', fixedPoint: true });
    assert.notEqual(readOptional(join(bank.dir, goldenMarkdownPath(file))), undefined, 'recorded Markdown exists');
    assert.notEqual(readOptional(join(bank.dir, goldenYjsPath(file))), undefined, 'recorded Yjs exists');
  });
}

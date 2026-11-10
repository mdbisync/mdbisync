import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadBank } from './bank.ts';
import type { ProbeRun } from './probe.ts';
import { findDrift } from './record.ts';

const bank = loadBank();

for (const [name, href, canary] of [
  ['audio-mp3', '../assets/clip.mp3', 'kx-c508f251'],
  ['audio-not-uploaded', '../media/voice-note.mp3', 'kx-f7252e1b'],
]) {
  test(`the recorded ${name} form matches Linear's stable list-item link`, () => {
    const file = `list-items/${name}.md`;
    const fixture = bank.fixtures.find((entry) => entry.file === file)!;
    const markdown = `* [Voice note from the site visit](<${href}>)\n\nRef ${canary}`;
    // Observed for both uploaded and unresolved MP3 links: an ordinary link
    // inside the list paragraph, with no attachment or audio node.
    const yjs = {
      roots: ['prosemirror'],
      content: [
        { type: 'bullet_list', children: [
          { type: 'list_item', children: [
            { type: 'paragraph', children: [
              { text: 'Voice note from the site visit', marks: { attribution: 'user', link: { href, noEmbed: null } } },
            ] },
          ] },
        ] },
        { type: 'paragraph', children: [{ text: `Ref ${canary}`, marks: { attribution: 'user' } }] },
      ],
    };
    const run: ProbeRun = {
      runId: 'recorded-audio', startedAt: '', facts: {}, uploads: [], cleanup: [],
      fixtures: [{
        ...fixture, source: readFileSync(join(bank.dir, file), 'utf8'),
        first: markdown, second: markdown, fixedPoint: true, yjs, yjsStable: true,
      }],
    };
    assert.deepEqual(findDrift(bank, run), []);
  });
}

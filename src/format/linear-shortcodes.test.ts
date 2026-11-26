// Linear can export an emoji added in its editor as its shortcode, and
// exports the same emoji written through the API as the emoji itself.
// The sync reads both as the same document.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fixLinearText, fixText } from './fix.ts';
import { lintText } from './lint.ts';
import { sameAsLinear, sameMarkdown } from './markdown.ts';

const url = '<https://example.com/img/1f5d3-fe0f.png>';

describe('Linear emoji shortcodes', () => {
  it('reads an emoji and the shortcode Linear exports for it as the same document', () => {
    const cases: Array<[string, string]> = [
      // Linear's export, then the file in fix's form.
      [`[:spiral_calendar_pad:](${url}) Planning`, `[🗓️](${url}) Planning`],
      [`[:spiral_calendar_pad: Planning](${url})`, `[🗓️ Planning](${url})`],
      ['Plan :spiral_calendar_pad: today', 'Plan 🗓️ today'],
      ['# :spiral_calendar_pad: Planning', '# 🗓️ Planning'],
      ['**:spiral_calendar_pad:** Planning', '**🗓️** Planning'],
      [`* [:spiral_calendar_pad:](${url}) one\n* :movie_camera: two`, `* [🗓️](${url}) one\n* 🎥 two`],
      [`| A | B |\n| -- | -- |\n| [:spiral_calendar_pad:](${url}) | :heart: |\n\nRef`, `| A | B |\n| -- | -- |\n| [🗓️](${url}) | ❤️ |\n\nRef`],
      ['Done :tada::+1:', 'Done 🎉👍'],
      ['Rate :keycap_star:', 'Rate \\*️⃣'],
      ['﻿:tada:', '﻿🎉'],
    ];
    for (const [linear, file] of cases) {
      assert.ok(sameAsLinear(linear, file), JSON.stringify(linear));
      assert.equal(fixText(file), file, `fix keeps ${JSON.stringify(file)}`);
      assert.equal(fixText(linear), file, `fix writes ${JSON.stringify(file)}`);
      assert.equal(fixLinearText(linear, linear, () => false), file, `a pull writes ${JSON.stringify(file)}`);
      assert.deepEqual(lintText('notes.md', file), [], `${JSON.stringify(file)} is lint-clean`);
    }
  });

  it('keeps emoji that Linear exports as written', () => {
    // Written through the API, each came back unchanged, also when written again.
    for (const file of [
      `[🗓️](${url}) Planning`, `[🗓](${url}) Planning`, 'Plan 🗓︎ today', `[🎥](${url}) Recording`,
      `[Plan 🗓️ week](${url})`, '# 🗓️ Planning', '**🗓️** Planning', `[❤️](${url}) and ❤`,
      `[👩‍💻](${url}) and [🏳️‍🌈](${url})`, `[👍🏽](${url}) and [👍](${url})`, `[🇯🇵](${url})`,
      `[1️⃣](${url}) and [#️⃣](${url})`, `[🫨](${url}) shaking`, `[🗓️🎥](${url})`,
    ]) {
      assert.equal(fixText(file), file, JSON.stringify(file));
      assert.equal(fixLinearText(file, file, () => false), file, JSON.stringify(file));
    }
  });

  it('keeps a shortcode that is no emoji in Linear apart from the emoji', () => {
    const cases: Array<[string, string]> = [
      ['Plan \\:spiral_calendar_pad: today', 'Plan 🗓️ today'],
      ['Plan `:tada:` today', 'Plan `🎉` today'],
      ['```\n:tada:\n```', '```\n🎉\n```'],
      ['Thanks :thumbsup:', 'Thanks 👍'],
      ['Plan :tada: today', 'Plan 🗓️ today'],
      ['See [notes](https://example.com/:tada:)', 'See [notes](https://example.com/🎉)'],
      ['See https://example.com/:tada:/x', 'See https://example.com/🎉/x'],
      ['See <https://example.com/:tada:/x>', 'See <https://example.com/🎉/x>'],
      ['See https://example.com/:tada:', 'See [https://example.com/🎉](<https://example.com/%F0%9F%8E%89>)'],
      // The emoji would change how the emphasis run next to it reads, so `fix` keeps the shortcode.
      ['Love **:heart:**ly', 'Love **❤️**ly'],
      ['Due :spiral_calendar_pad:**(tomorrow)**', 'Due 🗓️\\*\\*(tomorrow)\\*\\*'],
    ];
    for (const [linear, file] of cases) assert.ok(!sameAsLinear(linear, file), JSON.stringify(linear));
    assert.ok(!sameMarkdown('Plan :tada: today', 'Plan 🎉 today'), 'only the comparison with Linear reads shortcodes');
  });
});

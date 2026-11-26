// The emoji shortcodes Linear turns into emoji when it stores a document.
//
// Linear replaces `:name:` with the emoji, in plain text and in link text,
// for exactly the emoji ids of emoji-mart's Unicode 14 set: one name per
// emoji (Slack's first short name, such as `spiral_calendar_pad`), none of
// the set's other aliases (`thumbsup`, `satisfied`), and no emoji newer
// than Unicode 14 (`shaking_face`). Any other `:name:` stays text, GitHub's
// names among them (`:albania:`, `:1st_place_medal:`). Measured live by
// writing every name of the gemoji, emoji-mart, Slack, GitHub, JoyPixels,
// CLDR and Emojibase sets to a document and reading it back.
//
// Source of linear-emoji.json: `sets/14/native.json` of the npm package
// `@emoji-mart/data` 1.2.1 (MIT License, Copyright (c) Missive), each
// emoji id with its first skin's `native`. Regenerate it with:
//
//   npm pack @emoji-mart/data@1.2.1 && tar xzf emoji-mart-data-1.2.1.tgz && node -e "const d=require('./package/sets/14/native.json');console.log(JSON.stringify(Object.fromEntries(Object.entries(d.emojis).map(([k,v])=>[k,v.skins[0].native])),null,2))" > src/format/linear-emoji.json
//
// Update path: when Linear's editor moves to a newer set, write the names
// of the newer emoji-mart set to a document in a Linear workspace, read it
// back, and when Linear converts them, regenerate the table from that set
// (`sets/15`, or a newer package version).

import table from './linear-emoji.json' with { type: 'json' };

/** Shortcode name (without colons) to the emoji Linear writes for it. */
export const LINEAR_EMOJI: ReadonlyMap<string, string> = new Map(Object.entries(table));

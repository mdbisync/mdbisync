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
// The table is src/vendor/emoji-mart-data/linear-emoji.json: the emoji ids
// of `sets/14/native.json` of `@emoji-mart/data` 1.2.1 (MIT License,
// Copyright (c) Missive), each with its first skin's `native`. The folder
// carries the package's name, version, license and LICENSE, so the build
// lists it among the bundled third-party packages and ships its notice.
// The package itself is only a development dependency; linear-emoji.test.ts
// checks that the table, the folder and the locked package agree.
// Regenerate the table with:
//
//   node -e "const d=require('@emoji-mart/data/sets/14/native.json');console.log(JSON.stringify(Object.fromEntries(Object.entries(d.emojis).map(([k,v])=>[k,v.skins[0].native])),null,2))" > src/vendor/emoji-mart-data/linear-emoji.json
//
// Update path: when Linear's editor moves to a newer set, write the names
// of the newer emoji-mart set to a document in a Linear workspace, read it
// back, and when Linear converts them, regenerate the table from that set
// (`sets/15`, or a newer package version, updating the folder's
// package.json and LICENSE with it).

import table from '../vendor/emoji-mart-data/linear-emoji.json' with { type: 'json' };

/** Shortcode name (without colons) to the emoji Linear writes for it. */
export const LINEAR_EMOJI: ReadonlyMap<string, string> = new Map(Object.entries(table));

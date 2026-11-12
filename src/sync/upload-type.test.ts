import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { uploadExtension } from './upload-type.ts';

for (const [file, extension] of [
  ['pixel.png', '.png'], ['photo.jpg', '.jpg'], ['blink.gif', '.gif'],
  ['pixel.webp', '.webp'], ['summary.pdf', '.pdf'], ['clip.mp4', '.mp4'],
  ['clip.webm', '.webm'], ['shapes.svg', '.svg'],
]) {
  it(`identifies ${file} by its bytes`, async () => {
    assert.equal(uploadExtension(await readFile(new URL(`../../test/fixtures/assets/${file}`, import.meta.url))), extension);
  });
}

it('identifies a small AVIF image', async () => {
  assert.equal(uploadExtension(await readFile(new URL('../../test/data/upload-pixel.avif', import.meta.url))), '.avif');
});

for (const xml of [
  '<svg xmlns="http://www.w3.org/2000/svg"><path id="shape"/><use href="#shape"/></svg>',
  '<?xml version="1.0"?><!-- drawing --><svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="&#35;shape"/></svg>',
]) it('admits well-formed SVG with fragment references', () => assert.equal(uploadExtension(Buffer.from(xml)), '.svg'));

for (const value of [
  '', 'unknown', '<html><body>Page</body></html>',
  '<!-- page --><html><body>Page</body></html>',
  '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"/>',
  '<svg><script/></svg>', '<svg><foreignObject/></svg>',
  '<svg onload="run()"/>', '<svg><path onclick="run()"/></svg>',
  '<svg><use href="https://example.com/picture.svg#shape"/></svg>',
  '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="data:image/png;base64,AA"/></svg>',
  '<svg><use href="&#104;ttps://example.com/picture.svg"/></svg>',
  '<svg><use href=""/></svg>', '<svg><path></svg>', '<svg/><html/>',
  '<!DOCTYPE svg [<!ENTITY image "#shape">]><svg/>',
  '<?xml-stylesheet href="https://example.com/style.css"?><svg/>',
  '<svg xmlns="http://www.w3.org/1999/xhtml"/>',
  '<svg xmlns:s="http://www.w3.org/2000/svg"><s:script/></svg>',
]) it(`refuses unsupported content: ${value}`, () => assert.equal(uploadExtension(Buffer.from(value)), null));

it('refuses malformed and unsupported media signatures', () => {
  for (const bytes of [Buffer.from([0xff, 0xd8]), Buffer.from('RIFFxxxxWAVE'), Buffer.from('GIF00a'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('0000ftypheic0000')]) assert.equal(uploadExtension(bytes), null);
});

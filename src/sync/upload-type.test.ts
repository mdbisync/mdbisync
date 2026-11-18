import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { admitsCapturedFile, isCaptureName, uploadExtension } from './upload-type.ts';

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

const SVG = 'xmlns="http://www.w3.org/2000/svg"';
const XHTML = 'http://www.w3.org/1999/xhtml';

it('refuses a static SVG above the element limit', () => {
  const group = '<g>' + '<rect/>'.repeat(1000) + '</g>';
  assert.equal(uploadExtension(Buffer.from(`<svg>${group.repeat(50)}</svg>`)), null);
});

it('counts namespace declarations against the SVG complexity limit', () => {
  const group = '<g xmlns:d="urn:drawing">' + '<rect/>'.repeat(8) + '</g>';
  const atLimit = group.repeat(4999) + '<rect/>'.repeat(9);
  assert.equal(uploadExtension(Buffer.from(`<svg>${atLimit}</svg>`)), '.svg');
  assert.equal(uploadExtension(Buffer.from(`<svg>${atLimit}<rect/></svg>`)), null);
});

it('restores shadowed SVG bindings and removes local bindings before visiting siblings', () => {
  const xlink = 'http://www.w3.org/1999/xlink';
  // Use an unprefixed element where the element prefix is shadowed.
  const group = `<g xmlns:s="${xlink}" xmlns:local="${xlink}"><use s:href="#shape" local:href="#shape"/></g>`;
  const open = '<svg xmlns:s="http://www.w3.org/2000/svg">';
  assert.equal(uploadExtension(Buffer.from(`${open}${group}<s:rect id="shape"/></svg>`)), '.svg');
  assert.equal(uploadExtension(Buffer.from(`${open}${group}<use local:href="#shape"/></svg>`)), null);
});

for (const xml of [
  `<svg ${SVG}><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect fill="url(#g)" style="fill: url( '#g' )"/></svg>`,
  `<svg ${SVG}><style><![CDATA[rect { fill: url("#g"); stroke: red }]]></style><title>Shapes</title><text xml:space="preserve">a \\ b</text></svg>`,
  `<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:g><s:rect/></s:g></s:svg>`,
]) it(`admits static SVG with fragment paint and local styles: ${xml}`, () => assert.equal(uploadExtension(Buffer.from(xml)), '.svg'));

/** Elements of another namespace, and stylesheets or paint that load another file. */
for (const value of [
  `<svg ${SVG}><iframe xmlns="${XHTML}" src="javascript:alert(1)"/></svg>`,
  `<svg ${SVG} xmlns:h="${XHTML}"><h:iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"/></svg>`,
  `<svg ${SVG} xmlns:h="${XHTML}"><h:object data="https://example.com/page.html"/></svg>`,
  `<svg ${SVG} xmlns:h="${XHTML}"><h:embed src="https://example.com/page.html"/></svg>`,
  `<svg ${SVG}><g xmlns="${XHTML}"><iframe src="javascript:alert(1)"/></g></svg>`,
  `<svg ${SVG}><g xmlns:s="http://www.w3.org/2000/svg" xmlns="${XHTML}"><s:rect/><div/></g></svg>`,
  `<svg ${SVG} xmlns:x="http://www.w3.org/2000/svg"><x:g xmlns:x="${XHTML}"><x:iframe src="javascript:alert(1)"/></x:g></svg>`,
  `<svg ${SVG}><g xmlns=""><rect/></g></svg>`,
  `<svg ${SVG}><g xmlns="${XHTML}" xmlns:="http://www.w3.org/2000/svg"><iframe/></g></svg>`,
  `<svg ${SVG}><image href="#shape"/></svg>`, `<svg ${SVG}><feImage href="#shape"/></svg>`,
  `<svg ${SVG}><rect s:fill="red" xmlns:s="http://www.w3.org/2000/svg"/></svg>`,
  `<svg ${SVG}><style>@import url(https://example.com/style.css);</style></svg>`,
  `<svg ${SVG}><style>@IMPORT "https://example.com/style.css";</style></svg>`,
  `<svg ${SVG}><style>@<g/>import "https://example.com/style.css";</style></svg>`,
  `<svg ${SVG}><style>rect { fill: url(<g>#</g>https://example.com/paint.svg#p) }</style><rect/></svg>`,
  `<svg ${SVG}><style><![CDATA[rect { fill: url(https://example.com/paint.svg#p) }]]></style></svg>`,
  `<svg ${SVG}><style>rect { background: \\75 rl(https://example.com/a.png) }</style></svg>`,
  `<svg ${SVG}><style>rect { background: image-set("https://example.com/a.png" 1x) }</style></svg>`,
  `<svg ${SVG}><rect style="fill: url('https://example.com/paint.svg#p')"/></svg>`,
  `<svg ${SVG}><rect style="@import url(https://example.com/style.css)"/></svg>`,
  `<svg ${SVG}><rect fill="URL(https://example.com/paint.svg#p)"/></svg>`,
  `<svg ${SVG}><rect filter="url( data:image/svg+xml,x)"/></svg>`,
  `<svg ${SVG}><rect fill="url('&#160;#paint')"/></svg>`,
]) it(`refuses foreign elements and external stylesheets: ${value}`, () => assert.equal(uploadExtension(Buffer.from(value)), null));

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
  '<svg><a href="#safe"><set attributeName="href" to="javascript:alert(1)"/></a></svg>',
  '<svg><a><animate attributeName="href" values="javascript:alert(1)"/></a></svg>',
  '<svg><animateTransform attributeName="transform"/></svg>',
  '<svg xml:base="https://example.com/asset.svg"><use href="#shape"/></svg>',
  '<svg xmlns="http://www.w3.org/2000/svg"><Script/></svg>',
  '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:x:href="javascript:alert(1)"/></svg>',
  '<svg xmlns:xml="http://www.w3.org/1999/xlink"><rect xml:base="https://example.com/"/></svg>',
]) it(`refuses unsupported content: ${value}`, () => assert.equal(uploadExtension(Buffer.from(value)), null));

it('refuses malformed and unsupported media signatures', () => {
  for (const bytes of [Buffer.from([0xff, 0xd8]), Buffer.from('RIFFxxxxWAVE'), Buffer.from('GIF00a'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('0000ftypheic0000')]) assert.equal(uploadExtension(bytes), null);
});

it('reads WebM DocType structurally, including longer length encodings', () => {
  const header = Buffer.from([0x1a,0x45,0xdf,0xa3]);
  const docType = Buffer.from([0x42,0x82,0x40,0x04,0x77,0x65,0x62,0x6d]);
  assert.equal(uploadExtension(Buffer.concat([header, Buffer.from([0x88]), docType])), '.webm');
  const matroska = Buffer.concat([Buffer.from([0x42,0x82,0x88]),Buffer.from('matroska'),Buffer.from([0x42,0x83,0x87,0x42,0x82,0x84,0x77,0x65,0x62,0x6d])]);
  assert.equal(uploadExtension(Buffer.concat([header,Buffer.from([0x80 | matroska.length]),matroska])), null);
});

it('re-checks only files named as a capture names an upload', async () => {
  const hash = 'a'.repeat(64);
  const png = await readFile(new URL('../../test/fixtures/assets/pixel.png', import.meta.url));
  const xhtml = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><iframe xmlns="http://www.w3.org/1999/xhtml" src="javascript:alert(1)"/></svg>');
  assert.equal(isCaptureName(`docs/${hash}.svg`), true);
  for (const name of [`docs/${hash}.html`, `docs/${hash.toUpperCase()}.svg`, `docs/${hash}.svg.svg`, `docs/${hash.slice(1)}.svg`, 'docs/logo.svg']) assert.equal(isCaptureName(name), false, name);
  assert.equal(admitsCapturedFile(`docs/${hash}.png`, png), true);
  assert.equal(admitsCapturedFile(`docs/${hash}.svg`, xhtml), false, 'bytes the check now refuses');
  assert.equal(admitsCapturedFile(`docs/${hash}.svg`, png), false, 'a type that disagrees with the extension');
  assert.equal(admitsCapturedFile('docs/logo.svg', xhtml), true, 'a file a person named came through git');
});

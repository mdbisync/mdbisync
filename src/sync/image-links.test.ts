import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { imageLinks } from './image-links.ts';
import { parse, visit } from '../format/markdown.ts';

function images(body: string): string[] {
  const definitions = new Map<string, string>();
  visit(parse(body), node => { if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url); });
  const urls: string[] = [];
  visit(parse(body), node => {
    if (node.type === 'image') urls.push(node.url);
    if (node.type === 'imageReference' && definitions.has(node.identifier)) urls.push(definitions.get(node.identifier)!);
  });
  return urls;
}

for (const [source, expected] of [
  ['![Chart](https://example.com/chart.png)', '[Chart](https://example.com/chart.png)'],
  ['![](http://example.com/a.png)', '[http://example.com/a.png](http://example.com/a.png)'],
  ['![Chart](../chart.png)', '[Chart](../chart.png)'],
  ['![Chart](/chart.png)', '[Chart](/chart.png)'],
  ['[![Chart](https://example.com/a.png)](https://example.com)', '[Chart](https://example.com)'],
  ['![]()', ''],
  ['![Chart](data:image/png;base64,AAAA)', ''],
  ['[Remove](javascript:alert%281%29)', ''],
  ['[Remove](java&#x09;script:alert%281%29)', ''],
  ['[Remove](&#32;javascript:alert%281%29)', ''],
  ['[Remove][bad]\n\n[bad]: data:text/plain,hello', '\n\n'],
  ['![Chart][image]\n\n[image]: https://example.com/a.png', '[Chart](https://example.com/a.png)\n\n[image]: https://example.com/a.png'],
  ['`![Chart](../chart.png)`', '`![Chart](../chart.png)`'],
  ['![Chart](https://uploads.linear.app/chart.png)', '![Chart](https://uploads.linear.app/chart.png)'],
]) it(`repairs pull Markdown: ${source}`, () => assert.equal(imageLinks(source!).body, expected));

it('reports original image places and lines, including removed images', () => {
  const source = '![Kept](https://uploads.linear.app/a)\n\n![Dead](https://uploads.linear.app/dead)\n\n![]()\n';
  const result = imageLinks(source, new Set(['https://uploads.linear.app/dead']));
  assert.deepEqual(result.images, [{image:2,total:3,line:3},{image:3,total:3,line:5}]);
  assert.match(result.body, /\[Dead\]\(https:\/\/uploads.linear.app\/dead\)/);
});

it('keeps table cells intact when alt text contains a pipe', () => {
  const source = '| Image | Note |\n| -- | -- |\n| ![A\\|B](https://example.com/chart.png) | Keep |\n';
  const result = imageLinks(source).body;
  assert.match(result, /\[A&#124;B\]/);
  assert.match(result, /\| Keep \|/);
});
it('keeps a leading byte order mark while rewriting an image', () => {
  assert.equal(imageLinks('\uFEFF![Chart](https://example.com/chart.png)').body, '\uFEFF[Chart](https://example.com/chart.png)');
});

// A literal `!` before a repaired image, or text that a removal joins, must never re-create an image.
for (const [source, expected] of [
  ['!![x](../secret.txt)', '\\![x](../secret.txt)'],
  ['Look !![x](https://example.com/a.png) here', 'Look \\![x](https://example.com/a.png) here'],
  ['!![x][r]\n\n[r]: ../secret.txt', '\\![x](../secret.txt)\n\n[r]: ../secret.txt'],
  ['\\\\!![x](../secret.txt)', '\\\\\\![x](../secret.txt)'],
  ['\\!![x](../secret.txt)', '\\![x](../secret.txt)'],
  ['!![]()[y](../secret.txt)', '\\![y](../secret.txt)'],
  ['!![d](data:image/png;base64,AAAA)[y][r]\n\n[r]: ../secret.txt', '\\![y][r]\n\n[r]: ../secret.txt'],
  ['![a][b](javascript:alert%281%29)(../secret.txt)', '\\!\\[a](../secret.txt)'],
  ['| A |\n| -- |\n| !![x](../secret.txt) |', '| A |\n| -- |\n| \\![x](../secret.txt) |'],
  ['\uFEFF!![x](../secret.txt)', '\uFEFF\\![x](../secret.txt)'],
]) it(`does not re-create an image next to a literal bang: ${JSON.stringify(source)}`, () => {
  const body = imageLinks(source!).body;
  assert.equal(body, expected);
  assert.deepEqual(images(body), []);
});

// The same joins can form a link or a definition that Linear's text never held.
for (const [source, expected] of [
  ['[t][b](javascript:1)(../records.csv)', '\\[t](../records.csv)'],
  ['[a](javascript:x)\n[r]: ../records.csv', '\n\\[r]: ../records.csv'],
  ['[t][b](javascript:1)[r]\n\n[r]: ../records.csv', '\\[t][r]\n\n[r]: ../records.csv'],
  ['Keep [this](../records.csv) and [that][r]\n\n[r]: ../records.csv', 'Keep [this](../records.csv) and [that][r]\n\n[r]: ../records.csv'],
]) it(`does not create a link a removal joins: ${JSON.stringify(source)}`, () => assert.equal(imageLinks(source!).body, expected));

it('keeps an upload image next to a bang and repairs only the others', () => {
  const source = '!![Kept](https://uploads.linear.app/a) !![x](../secret.txt)';
  const body = imageLinks(source).body;
  assert.equal(body, '!![Kept](https://uploads.linear.app/a) \\![x](../secret.txt)');
  assert.deepEqual(images(body), ['https://uploads.linear.app/a']);
});

it('keeps an upload image whose destination a joined image repeats', () => {
  const source = '!![]()[x](https://uploads.linear.app/a) ![Kept](https://uploads.linear.app/a)';
  const body = imageLinks(source).body;
  assert.equal(body, '\\![x](https://uploads.linear.app/a) ![Kept](https://uploads.linear.app/a)');
  assert.deepEqual(images(body), ['https://uploads.linear.app/a']);
});

it('repairs only the selected images and still never adds one', () => {
  const source = '![A](https://example.com/a.png) !![B](../secret.txt)';
  assert.equal(imageLinks(source, new Set(), new Set([2])).body, '![A](https://example.com/a.png) \\![B](../secret.txt)');
});

// Recorded by the format probe: Linear moves an image into its own block, so a literal `!` it
// stores never sits directly before the image. The repair above holds even if that changes.
for (const name of ['bang-before-inline', 'bang-before-reference']) it(`Linear keeps a bang apart from the image (${name})`, () => {
  const linear = readFileSync(new URL(`../../test/fixtures/images/${name}.linear.md`, import.meta.url), 'utf8');
  assert.match(linear, /^Look !\n\n/);
  assert.doesNotMatch(linear, /!!\[/);
  assert.deepEqual(images(imageLinks(linear).body), []);
});

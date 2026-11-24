import assert from 'node:assert/strict';
import { it, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { imageLinks, ImageRepairBudgetError } from './image-links.ts';
import { parse, visit } from '../format/markdown.ts';
import { fixText } from '../format/index.ts';

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
  ['![Chart](https://example.com/chart.png)', '[Chart](<https://example.com/chart.png>)'],
  ['![](http://example.com/a.png)', '[http://example.com/a.png](<http://example.com/a.png>)'],
  ['![Chart](../chart.png)', '[Chart](<../chart.png>)'],
  ['![Chart](/chart.png)', '[Chart](</chart.png>)'],
  ['[![Chart](https://example.com/a.png)](https://example.com)', '[Chart](https://example.com)'],
  ['![]()', ''],
  ['![Chart](data:image/png;base64,AAAA)', ''],
  ['[Remove](javascript:alert%281%29)', ''],
  ['[Remove](java&#x09;script:alert%281%29)', ''],
  ['[Remove](&#32;javascript:alert%281%29)', ''],
  ['[Remove][bad]\n\n[bad]: data:text/plain,hello', '\n\n'],
  ['![Chart][image]\n\n[image]: https://example.com/a.png', '[Chart](<https://example.com/a.png>)\n\n[image]: https://example.com/a.png'],
  ['`![Chart](../chart.png)`', '`![Chart](../chart.png)`'],
  ['![Chart](https://uploads.linear.app/chart.png)', '![Chart](https://uploads.linear.app/chart.png)'],
]) it(`repairs pull Markdown: ${source}`, () => assert.equal(imageLinks(source!).body, expected));

it('reports original image places and lines, including removed images', () => {
  const source = '![Kept](https://uploads.linear.app/a)\n\n![Dead](https://uploads.linear.app/dead)\n\n![]()\n';
  const result = imageLinks(source, new Set(['https://uploads.linear.app/dead']));
  assert.deepEqual(result.images, [{image:2,total:3,line:3},{image:3,total:3,line:5}]);
  assert.match(result.body, /\[Dead\]\(<https:\/\/uploads.linear.app\/dead>\)/);
});

it('keeps table cells intact when alt text contains a pipe', () => {
  const source = '| Image | Note |\n| -- | -- |\n| ![A\\|B](https://example.com/chart.png) | Keep |\n';
  const result = imageLinks(source).body;
  assert.match(result, /\[A&#124;B\]/);
  assert.match(result, /\| Keep \|/);
});
it('keeps a leading byte order mark while rewriting an image', () => {
  assert.equal(imageLinks('\uFEFF![Chart](https://example.com/chart.png)').body, '\uFEFF[Chart](<https://example.com/chart.png>)');
});

// A literal `!` before a repaired image, or text that a removal joins, must never re-create an image.
for (const [source, expected] of [
  ['!![x](../secret.txt)', '\\![x](<../secret.txt>)'],
  ['Look !![x](https://example.com/a.png) here', 'Look \\![x](<https://example.com/a.png>) here'],
  ['!![x][r]\n\n[r]: ../secret.txt', '\\![x](<../secret.txt>)\n\n[r]: ../secret.txt'],
  ['\\\\!![x](../secret.txt)', '\\\\\\![x](<../secret.txt>)'],
  ['\\!![x](../secret.txt)', '\\![x](<../secret.txt>)'],
  ['!![]()[y](../secret.txt)', '\\![y](../secret.txt)'],
  ['!![d](data:image/png;base64,AAAA)[y][r]\n\n[r]: ../secret.txt', '\\![y][r]\n\n[r]: ../secret.txt'],
  ['![a][b](javascript:alert%281%29)(../secret.txt)', '\\!\\[a](../secret.txt)'],
  ['| A |\n| -- |\n| !![x](../secret.txt) |', '| A |\n| -- |\n| \\![x](<../secret.txt>) |'],
  ['\uFEFF!![x](../secret.txt)', '\uFEFF\\![x](<../secret.txt>)'],
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
  assert.equal(body, '!![Kept](https://uploads.linear.app/a) \\![x](<../secret.txt>)');
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
  assert.equal(imageLinks(source, new Set(), new Set([2])).body, '![A](https://example.com/a.png) \\![B](<../secret.txt>)');
});

it('repairs a paragraph of simple images with the same text and positions as the Markdown path', () => {
  const source = '![Chart 1](../chart.png)  ![](folder/chart-2.svg) ![  ](plain)   ';
  for (const selected of [undefined, new Set([2, 3])]) {
    const simple = imageLinks(source, undefined, selected);
    const parsed = imageLinks(source + '\n', undefined, selected);
    assert.deepEqual(simple.images, parsed.images);
    assert.equal(simple.body + '\n', parsed.body);
  }
});

function assertBoundedRepair(source: string, expected: string, count: number, milliseconds: number) {
  // Run in a child so stalled synchronous repair can be interrupted.
  const run = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import { imageLinks } from ${JSON.stringify(new URL('./image-links.ts', import.meta.url).href)};
    const count = ${count};
    const body = ${JSON.stringify(source)}.repeat(count);
    const started = process.cpuUsage();
    const repair = imageLinks(body);
    assert.equal(repair.body, ${JSON.stringify(expected)}.repeat(count));
    assert.equal(repair.images.length, count);
    const elapsed = process.cpuUsage(started);
    const cpuMilliseconds = (elapsed.user + elapsed.system) / 1_000;
    assert.ok(cpuMilliseconds < ${milliseconds}, 'repair used ' + cpuMilliseconds + ' ms of CPU time');
  `], {timeout: 20_000, killSignal: 'SIGKILL', encoding: 'utf8'});
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
}

it('repairs 245,000 characters of simple images using under one second of CPU time', () => {
  assertBoundedRepair('![](x) ', '[x](<x>) ', 35_000, 1_000);
});

it('repairs thousands of images and escapes literal bangs across paragraphs', () => {
  assertBoundedRepair('See !![Chart](chart.png)\n\n', 'See \\![Chart](<chart.png>)\n\n', 6_000, 6_000);
});

it('bounds the total replacement text when images share a long reference destination', () => {
  const source = '![Chart][image] '.repeat(300) + '\n\n[image]: ' + 'x'.repeat(4_000);
  assert.throws(() => imageLinks(source).body, ImageRepairBudgetError);
});

// Recorded by the format probe: Linear moves an image into its own block, so a literal `!` it
// stores never sits directly before the image. The repair above holds even if that changes.
for (const name of ['bang-before-inline', 'bang-before-reference']) it(`Linear keeps a bang apart from the image (${name})`, () => {
  const linear = readFileSync(new URL(`../../test/fixtures/images/${name}.linear.md`, import.meta.url), 'utf8');
  assert.match(linear, /^Look !\n\n/);
  assert.doesNotMatch(linear, /!!\[/);
  assert.deepEqual(images(imageLinks(linear).body), []);
});

// Linear stores every inline link destination in angle brackets (live L2-42), as `fix` writes it: a repair
// spelled any other way leaves git and Linear one byte apart after the write-back.
for (const [source, repaired] of [
  ['![plan 1](https://uploads.linear.app/w/dead.png)', '[plan 1](<https://uploads.linear.app/w/dead.png>)'],
  ['![x](<https://example.com/a b.png>)', '[x](<https://example.com/a%20b.png>)'],
  ['![x](https://example.com/a(1).png)', '[x](<https://example.com/a(1).png>)'],
  ['![x](<https://example.com/a\\>b.png>)', '[x](<https://example.com/a%3Eb.png>)'],
  ['![a *b* [c]](../chart.png)', '[a b \\[c\\]](<../chart.png>)'],
  ['![x](https://example.com/a\\\\)', '[x](<https://example.com/a%5C>)'],
  ['![x](https://example.com/a\\\\\\\\)', '[x](<https://example.com/a%5C%5C>)'],
  ['![x](<https://example.com/a&#10;b.png>)', '[x](<https://example.com/a%0Ab.png>)'],
] as const) test(`a repaired link is spelled as Linear and fix spell it: ${JSON.stringify(source)}`, () => {
  const body = imageLinks(source, new Set(['https://uploads.linear.app/w/dead.png'])).body;
  assert.equal(body, repaired);
  assert.equal(fixText(body), body);
  assert.equal(parse(body).children.length, 1);
  let links = 0;
  visit(parse(body), node => { if (node.type === 'link') links++; });
  assert.equal(links, 1, 'the repair is a link, not text');
});

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { imageLinks } from './image-links.ts';

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

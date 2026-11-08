import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const directory = fileURLToPath(new URL('./scenarios/', import.meta.url));
export function checkCoverage(catalog: unknown, specs: { filename: string; id: unknown }[]): void {
  assert.ok(Array.isArray(catalog) && catalog.length > 0, 'catalog must be nonempty');
  for (const id of catalog) assert.match(id, /^L(?:[0-6]|1R)-\d{2}$/);
  assert.equal(new Set(catalog).size, catalog.length, 'duplicate catalog IDs');
  const seen = new Set<string>();
  for (const spec of specs) {
    assert.equal(typeof spec.id, 'string');
    const id = spec.id as string;
    assert.equal(spec.filename, `${id}.yaml`, 'filename/ID mismatch');
    assert.ok(!seen.has(id), `duplicate spec ${id}`);
    seen.add(id);
  }
  const missing = catalog.filter(id => !seen.has(id));
  const extra = [...seen].filter(id => !catalog.includes(id));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, 'catalog/spec mismatch');
}

test('scenario catalog and specs cover exactly the same IDs', () => {
  const catalog: unknown = JSON.parse(readFileSync(join(directory, 'catalog.json'), 'utf8'));
  if (process.env.SCENARIO_CATALOG_SOURCE) {
    const source = readFileSync(process.env.SCENARIO_CATALOG_SOURCE, 'utf8');
    const ids = [...source.matchAll(/^- \*\*(L(?:[0-6]|1R)-\d{2}) /gm)].map(match => match[1]);
    assert.deepEqual(catalog, ids, 'regenerate catalog.json from source headings');
  }
  const specs = readdirSync(directory).filter(name => /\.ya?ml$/i.test(name)).map(filename => ({
    filename,
    id: JSON.parse(readFileSync(join(directory, filename), 'utf8')).id as unknown,
  }));
  checkCoverage(catalog, specs);
});

test('coverage rejects missing, extra, duplicate, malformed and misnamed entries', () => {
  const spec = { filename: 'L0-01.yaml', id: 'L0-01' };
  assert.throws(() => checkCoverage(['L0-01'], []));
  assert.throws(() => checkCoverage(['L0-02'], [spec]));
  assert.throws(() => checkCoverage(['L0-01'], [spec, spec]));
  assert.throws(() => checkCoverage(['L0-01', 'L0-01'], [spec]));
  assert.throws(() => checkCoverage(['L0R-01'], []));
  assert.throws(() => checkCoverage(['L0-01'], [{ ...spec, filename: 'L0-02.yaml' }]));
  assert.throws(() => checkCoverage([], []));
});

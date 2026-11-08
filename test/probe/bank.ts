// The fixture bank as the format probe sees it: which fixtures go to Linear,
// where their recorded Linear forms live, and how asset links are swapped for
// uploaded URLs and back.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export const BANK_DIR = 'test/fixtures';
/** The probe's record of the last accepted run: fixed points and refusals per fixture. */
export const MANIFEST_FILE = 'linear-probe.json';

export interface BankFixture {
  file: string;
  group: string;
  construct: string;
  class: 'fixable' | 'lint-error' | 'unchanged';
  rule?: string;
  basis: 'known' | 'assumed';
  canary: string;
  synced?: boolean;
}

export interface BankAsset {
  file: string;
}

export interface Bank {
  dir: string;
  fixtures: BankFixture[];
  assets: BankAsset[];
}

export function loadBank(dir: string = BANK_DIR): Bank {
  const index = parse(readFileSync(join(dir, 'index.yaml'), 'utf8')) as {
    fixtures: Array<BankFixture & { synced?: boolean | string }>;
    assets?: BankAsset[];
  };
  const fixtures = index.fixtures.map((fixture) => ({
    ...fixture,
    synced: fixture.synced === undefined ? undefined : String(fixture.synced) !== 'false',
  })) as BankFixture[];
  return { dir, fixtures, assets: index.assets ?? [] };
}

/** Fixtures the probe writes to Linear: synchronized `.md` files (only `.md` files sync). */
export function probedFixtures(bank: Bank): BankFixture[] {
  return bank.fixtures.filter((fixture) => fixture.synced !== false && /\.md$/.test(fixture.file));
}

export function goldenMarkdownPath(file: string): string {
  return file.replace(/\.md$/, '.linear.md');
}

export function goldenYjsPath(file: string): string {
  return file.replace(/\.md$/, '.linear.yjs.json');
}

export function readFixture(bank: Bank, fixture: BankFixture): string {
  return readFileSync(join(bank.dir, fixture.file), 'utf8');
}

export function readOptional(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** Asset files that probed fixtures link to (`../assets/<name>`). */
export function linkedAssets(bank: Bank, texts: readonly string[]): string[] {
  const known = new Set(bank.assets.map((asset) => asset.file));
  return [...known].filter((file) => texts.some((text) => assetSpellings(file).some((spelling) => text.includes(spelling)))).sort();
}

/** The ways a fixture spells a link to an asset: plain and percent-encoded. */
export function assetSpellings(assetFile: string): string[] {
  const plain = `../${assetFile}`;
  const encoded = `../${assetFile.split('/').map(encodeURIComponent).join('/')}`;
  return plain === encoded ? [plain] : [plain, encoded];
}

export interface AssetMap {
  /** Asset file (relative to the bank) to its uploaded URL. */
  urls: Map<string, string>;
}

/** Replaces links to bank assets with their uploaded URLs. */
export function toLinear(text: string, assets: AssetMap): string {
  let result = text;
  for (const [file, url] of assets.urls) {
    for (const spelling of assetSpellings(file)) result = result.replaceAll(spelling, url);
  }
  return result;
}

/**
 * Replaces uploaded asset URLs with the bank path, so recorded forms are
 * stable across runs. The path is percent-encoded like the upload URL it
 * stands for, so a recorded form stays a valid link where the path has spaces.
 */
export function fromLinear(text: string, assets: AssetMap): string {
  let result = text;
  for (const [file, url] of assets.urls) result = result.replaceAll(url, assetSpellings(file).at(-1)!);
  return result;
}

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  csv: 'text/csv',
  txt: 'text/plain',
  json: 'application/json',
};

export function contentTypeOf(file: string): string {
  const extension = file.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

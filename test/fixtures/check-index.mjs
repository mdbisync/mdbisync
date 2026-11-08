#!/usr/bin/env node
// Checks the fixture bank against its index (index.yaml).
// Runs on Node 24 with no dependencies: `node test/fixtures/check-index.mjs [bank-dir]`.
// Exits 1 and lists every problem when the bank and the index disagree.

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLASSES = ['fixable', 'lint-error', 'unchanged'];
export const BASES = ['known', 'assumed'];
export const MIN_FIXTURES = 200;
const CANARY = /^kx-[0-9a-f]{8}$/;
const CANARY_ANY = /kx-[0-9a-f]{8}/g;
// Cyrillic, Cyrillic Supplement, Extended-A/B/C. Non-Latin test text uses other scripts.
const CYRILLIC = /[\u0400-\u052F\u1C80-\u1C8F\u2DE0-\u2DFF\uA640-\uA69F]/u;
const ROOT_FILES = new Set(['.gitattributes', 'index.yaml', 'README.md', 'check-index.mjs', 'check-index.test.mjs', 'linear-probe.json']);
// Linear's recorded forms, written beside each fixture by the format probe.
const PROBE_OUTPUT = /\.linear\.(md|yjs\.json)$/;
const ASSETS_DIR = 'assets';
const MARKDOWN = /\.md$/; // only .md files are synchronized

// ---------------------------------------------------------------------------
// A parser for the small YAML subset index.yaml uses: top-level scalars and
// top-level lists of flat maps; scalars are plain or double-quoted (JSON
// escapes). Anything else is an error, so the index cannot drift into YAML
// this parser misreads.

export function parseIndex(text) {
  const out = {};
  let list = null;
  let item = null;
  const lines = text.split('\n');
  lines.forEach((raw, i) => {
    const where = `index.yaml:${i + 1}`;
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) return;
    let m;
    if ((m = /^([a-z_]+):\s*(.*)$/.exec(raw))) {
      item = null;
      if (m[2] === '') {
        list = [];
        setKey(out, m[1], list, where);
      } else {
        list = null;
        setKey(out, m[1], scalar(m[2], where), where);
      }
      return;
    }
    if ((m = /^ {2}- ([a-z_]+):\s*(.*)$/.exec(raw)) && list) {
      item = {};
      list.push(item);
      setKey(item, m[1], scalar(m[2], where), where);
      return;
    }
    if ((m = /^ {4}([a-z_]+):\s*(.*)$/.exec(raw)) && item) {
      setKey(item, m[1], scalar(m[2], where), where);
      return;
    }
    throw new Error(`${where}: unsupported line: ${raw}`);
  });
  return out;
}

function setKey(obj, key, value, where) {
  if (Object.hasOwn(obj, key)) throw new Error(`${where}: duplicate key ${key}`);
  obj[key] = value;
}

function scalar(s, where) {
  s = s.trim();
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      throw new Error(`${where}: bad quoted string ${s}`);
    }
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s === '' || /[:#{}[\],&*!|>'"%@`]/.test(s)) {
    throw new Error(`${where}: plain value needs quotes: ${s}`);
  }
  return s;
}

// ---------------------------------------------------------------------------

// Binary files (images, archives, a binary file named .md) are not valid UTF-8.
function textOrNull(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function walk(dir, base = dir) {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full, base));
    else files.push(relative(base, full).split(sep).join('/'));
  }
  return files;
}

// Fenced code blocks and code spans hold examples, not links: drop them
// before scanning. Indented code is rare in link fixtures and is kept.
function withoutCode(text) {
  return text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, '')
    .replace(/(`+)[^`]*?\1/g, '');
}

function decode(t) {
  try {
    return decodeURIComponent(t);
  } catch {
    return t;
  }
}

// Relative targets of Markdown links and images, reference definitions and
// HTML src/href attributes. External URLs, mail links and pure anchors are skipped.
export function relativeTargets(text) {
  text = withoutCode(text);
  const found = [];
  // Destination: <...>, or a run without spaces that may hold balanced parentheses.
  // Title: "...", '...' or (...).
  const inline = /\]\(\s*(<[^>]*>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  const refdef = /^ {0,3}\[(?!\^)[^\]]+\]:\s*(<[^>]*>|\S+)/gm; // not footnote definitions
  const html = /\b(?:src|href)="([^"]*)"/g;
  for (const re of [inline, refdef, html]) {
    for (const m of text.matchAll(re)) found.push(m[1]);
  }
  return found
    .map((t) => (t.startsWith('<') ? t.slice(1, -1) : t))
    .filter((t) => t && !t.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(t))
    .map((t) => decode(t.split('#')[0]));
}

// Some fixtures need file names that collide on case-insensitive file systems
// (macOS, Windows) or normalization-insensitive ones (macOS). They are committed
// under safe names; `name_as` is the name a test writes them under, and
// `macos_unsafe: true` marks them. Each such name must collide with another
// fixture's name_as and differ from it byte for byte.
// Upper then lower case folds final sigma and similar special cases alike.
const collisionKey = (name) => name.normalize('NFC').toUpperCase().toLowerCase();

function checkNameAs(fixtures, onDisk, err) {
  const named = fixtures.filter((f) => f.name_as !== undefined);
  for (const f of fixtures) {
    if ((f.name_as !== undefined) !== (f.macos_unsafe === true)) {
      err(`${f.file}: name_as and macos_unsafe: true go together`);
    }
  }
  const committed = new Set(onDisk.map(collisionKey));
  const seen = new Map();
  for (const f of named) {
    const as = f.name_as;
    if (typeof as !== 'string' || !MARKDOWN.test(as) || dirname(as) !== dirname(f.file)) {
      err(`${f.file}: name_as must be a .md name in the same folder`);
      continue;
    }
    if (seen.has(as)) err(`${f.file}: name_as also used by ${seen.get(as)}`);
    seen.set(as, f.file);
    if (committed.has(collisionKey(as))) err(`${f.file}: name_as ${as} collides with a committed file`);
    const partner = named.some(
      (o) => o !== f && typeof o.name_as === 'string' && o.name_as !== as && collisionKey(o.name_as) === collisionKey(as),
    );
    if (!partner) err(`${f.file}: name_as has no colliding partner`);
  }
}

export function checkBank(bankDir) {
  const errors = [];
  const err = (msg) => errors.push(msg);
  let index;
  try {
    index = parseIndex(readFileSync(join(bankDir, 'index.yaml'), 'utf8'));
  } catch (e) {
    return { errors: [e.message], stats: {} };
  }
  for (const key of ['groups', 'rules', 'known_constructs', 'assets', 'fixtures']) {
    if (!Array.isArray(index[key])) err(`index.yaml: missing list ${key}`);
  }
  if (errors.length) return { errors, stats: {} };

  const groups = new Set(index.groups.map((g) => g.id));
  const rules = new Set(index.rules.map((r) => r.id));
  const onDisk = walk(bankDir).filter((f) => !ROOT_FILES.has(f));
  const assetFiles = onDisk.filter((f) => f.startsWith(`${ASSETS_DIR}/`));
  const probeOutputs = onDisk.filter((f) => PROBE_OUTPUT.test(f));
  const fixtureFiles = onDisk.filter((f) => !f.startsWith(`${ASSETS_DIR}/`) && !PROBE_OUTPUT.test(f));

  // Every file indexed, every indexed file present, no duplicates.
  const indexed = new Map();
  for (const [i, f] of index.fixtures.entries()) {
    if (typeof f.file !== 'string' || f.file === '') {
      err(`index.yaml: fixture ${i + 1} has no file`);
      f.file = `(fixture ${i + 1})`;
    }
    if (indexed.has(f.file)) err(`${f.file}: indexed twice`);
    indexed.set(f.file, f);
  }
  for (const f of fixtureFiles) if (!indexed.has(f)) err(`${f}: not in index.yaml`);
  for (const f of indexed.keys()) if (!fixtureFiles.includes(f)) err(`${f}: indexed but missing`);
  for (const f of probeOutputs) {
    const source = f.replace(PROBE_OUTPUT, '.md');
    if (!indexed.has(source)) err(`${f}: recorded Linear form without its fixture`);
  }
  const assetIndex = new Set(index.assets.map((a) => a.file));
  for (const f of assetFiles) if (!assetIndex.has(f)) err(`${f}: asset not in index.yaml`);
  for (const f of assetIndex) if (!assetFiles.includes(f)) err(`${f}: indexed asset missing`);

  // Fields, groups, classes and rules.
  const canaries = new Map();
  const assetUse = new Map([...assetIndex].map((a) => [a, 0]));
  for (const f of index.fixtures) {
    const at = f.file;
    if (!groups.has(f.group)) err(`${at}: unknown group ${f.group}`);
    else if (at.split('/')[0] !== f.group) err(`${at}: not in the folder of group ${f.group}`);
    if (!f.construct) err(`${at}: no construct`);
    if (!CLASSES.includes(f.class)) err(`${at}: class must be one of ${CLASSES.join(', ')}`);
    if (!BASES.includes(f.basis)) err(`${at}: basis must be one of ${BASES.join(', ')}`);
    if (f.class === 'lint-error' && !rules.has(f.rule)) err(`${at}: lint-error needs a known rule`);
    if (f.class !== 'lint-error' && f.rule !== undefined) err(`${at}: only lint-error fixtures have a rule`);

    // Canary: well formed, unique, carried by the file (or its name when it cannot hold text).
    if (!CANARY.test(String(f.canary))) {
      err(`${at}: canary must match kx- and 8 hex digits`);
    } else {
      if (canaries.has(f.canary)) err(`${at}: canary also used by ${canaries.get(f.canary)}`);
      canaries.set(f.canary, at);
    }
    if (!fixtureFiles.includes(at)) continue;
    const bytes = readFileSync(join(bankDir, at));
    const text = bytes.toString('utf8');
    const latin = bytes.toString('latin1');
    const carrier = f.canary_in === 'name' ? at : latin;
    if (f.canary_in !== undefined && f.canary_in !== 'name') err(`${at}: canary_in can only be name`);
    if (!carrier.includes(f.canary)) err(`${at}: canary ${f.canary} not found`);
    const others = [...latin.matchAll(CANARY_ANY)].map((m) => m[0]).filter((c) => c !== f.canary);
    if (others.length) err(`${at}: carries another fixture's canary ${others[0]}`);

    // A file that is already in the target form must not end with a newline:
    // the target form has no final newline, so such a file would be fixable.
    if (f.class === 'unchanged' && f.synced !== false && MARKDOWN.test(at) && /[\r\n]$/.test(text)) {
      err(`${at}: unchanged fixture ends with a line break`);
    }

    // Relative link and image targets resolve inside the bank.
    if (MARKDOWN.test(at) && f.synced !== false) {
      let missing = 0;
      for (const target of relativeTargets(text)) {
        const resolved = normalize(join(dirname(at), target)).split(sep).join('/');
        if (assetUse.has(resolved)) assetUse.set(resolved, assetUse.get(resolved) + 1);
        if (resolved.startsWith('..') || !onDisk.includes(resolved)) missing++;
      }
      if (missing && f.missing_target !== true) err(`${at}: ${missing} relative target(s) do not exist`);
      if (!missing && f.missing_target === true) err(`${at}: marked missing_target but every target exists`);
    }
  }
  for (const [a, n] of assetUse) if (n === 0) err(`${a}: asset not used by any fixture`);

  // Coverage: every group, every rule and every known construct.
  for (const g of groups) {
    if (!index.fixtures.some((f) => f.group === g)) err(`group ${g}: no fixtures`);
  }
  for (const r of rules) {
    if (!index.fixtures.some((f) => f.rule === r)) err(`rule ${r}: no fixtures`);
  }
  checkNameAs(index.fixtures, onDisk, err);
  // A known construct has a fixture with basis known, and no fixture of it
  // contradicts the known class. Basis known is only for listed constructs.
  const known = new Map(index.known_constructs.map((k) => [k.construct, k.class]));
  for (const [construct, cls] of known) {
    const hit = index.fixtures.filter((f) => f.construct === construct);
    if (!hit.some((f) => f.basis === 'known')) err(`known construct ${construct}: no fixture with basis known`);
    for (const f of hit) {
      if (f.class !== cls) err(`${f.file}: class ${f.class} contradicts known class ${cls} of ${construct}`);
    }
  }
  for (const f of index.fixtures) {
    if (f.basis === 'known' && !known.has(f.construct)) {
      err(`${f.file}: basis known, but ${f.construct} is not in known_constructs`);
    }
  }
  if (index.fixtures.length < MIN_FIXTURES) {
    err(`only ${index.fixtures.length} fixtures, at least ${MIN_FIXTURES} expected`);
  }

  // Public hygiene of the test data itself.
  for (const f of [...onDisk, 'index.yaml']) {
    const text = textOrNull(readFileSync(join(bankDir, f)));
    if (text !== null && CYRILLIC.test(text)) err(`${f}: contains Cyrillic`);
    if (CYRILLIC.test(f)) err(`${f}: file name contains Cyrillic`);
  }

  return {
    errors,
    stats: { fixtures: index.fixtures.length, assets: assetFiles.length, groups: groups.size },
  };
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const self = fileURLToPath(import.meta.url);
if (isMain()) {
  const dir = resolve(process.argv[2] ?? dirname(self));
  const { errors, stats } = checkBank(dir);
  if (errors.length) {
    for (const e of errors) console.error(e);
    console.error(`fixture bank: ${errors.length} problem(s)`);
    process.exit(1);
  }
  console.log(`fixture bank ok: ${stats.fixtures} fixtures, ${stats.assets} assets, ${stats.groups} groups`);
}

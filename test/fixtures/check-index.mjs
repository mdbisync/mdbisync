#!/usr/bin/env node
// Checks the fixture bank against its index (index.yaml).
// Runs on Node 24 with no dependencies: `node test/fixtures/check-index.mjs [bank-dir]`.
// Exits 1 and lists every problem when the bank and the index disagree.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLASSES = ['fixable', 'lint-error', 'unchanged'];
export const BASES = ['known', 'assumed'];
export const MIN_FIXTURES = 200;
const CANARY = /^kx-[0-9a-f]{8}$/;
const CANARY_ANY = /kx-[0-9a-f]{8}/g;
// Cyrillic, Cyrillic Supplement, Extended-A/B/C. Non-Latin test text uses other scripts.
const CYRILLIC = /[\u0400-\u052F\u1C80-\u1C8F\u2DE0-\u2DFF\uA640-\uA69F]/u;
const ROOT_FILES = new Set(['.gitattributes', 'index.yaml', 'README.md', 'check-index.mjs', 'check-index.test.mjs']);
const ASSETS_DIR = 'assets';

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
        list = out[m[1]] = [];
      } else {
        list = null;
        out[m[1]] = scalar(m[2], where);
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

// Relative targets of Markdown links and images, reference definitions and
// HTML src/href attributes. External URLs, mail links and pure anchors are skipped.
export function relativeTargets(text) {
  const found = [];
  const inline = /\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  const refdef = /^ {0,3}\[(?!\^)[^\]]+\]:\s*(<[^>]*>|\S+)/gm; // not footnote definitions
  const html = /\b(?:src|href)="([^"]*)"/g;
  for (const re of [inline, refdef, html]) {
    for (const m of text.matchAll(re)) found.push(m[1]);
  }
  return found
    .map((t) => (t.startsWith('<') ? t.slice(1, -1) : t))
    .filter((t) => t && !t.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(t))
    .map((t) => decodeURIComponent(t.split('#')[0]));
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
  const fixtureFiles = onDisk.filter((f) => !f.startsWith(`${ASSETS_DIR}/`));

  // Every file indexed, every indexed file present, no duplicates.
  const indexed = new Map();
  for (const f of index.fixtures) {
    if (indexed.has(f.file)) err(`${f.file}: indexed twice`);
    indexed.set(f.file, f);
  }
  for (const f of fixtureFiles) if (!indexed.has(f)) err(`${f}: not in index.yaml`);
  for (const f of indexed.keys()) if (!fixtureFiles.includes(f)) err(`${f}: indexed but missing`);
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
    if (f.class === 'unchanged' && f.synced !== false && at.endsWith('.md') && text.endsWith('\n')) {
      err(`${at}: unchanged fixture ends with a newline`);
    }

    // Relative link and image targets resolve inside the bank.
    if (/\.(md|markdown)$/.test(at) && f.synced !== false) {
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
  for (const k of index.known_constructs) {
    const hit = index.fixtures.filter((f) => f.construct === k.construct);
    if (!hit.length) err(`known construct ${k.construct}: no fixture`);
    else if (!hit.some((f) => f.class === k.class && f.basis === 'known')) {
      err(`known construct ${k.construct}: no fixture with class ${k.class} and basis known`);
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

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const dir = resolve(process.argv[2] ?? dirname(self));
  const { errors, stats } = checkBank(dir);
  if (errors.length) {
    for (const e of errors) console.error(e);
    console.error(`fixture bank: ${errors.length} problem(s)`);
    process.exit(1);
  }
  console.log(`fixture bank ok: ${stats.fixtures} fixtures, ${stats.assets} assets, ${stats.groups} groups`);
}

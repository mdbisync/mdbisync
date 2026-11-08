// Decodes a Linear document's `contentState` (a base64 Yjs update holding the
// editor's ProseMirror document) into a stable JSON tree of nodes, attributes,
// marks and text. Values that change from run to run (block ids, upload ids,
// the users who typed the text, uploaded asset URLs) are replaced by
// placeholders, so the tree can be compared across runs.

import * as Y from 'yjs';

export type YjsNode =
  | { type: string; attrs?: Record<string, unknown>; children?: YjsNode[] }
  | { text: string; marks?: Record<string, unknown> };

export interface YjsSummary {
  /** Root types found in the state; Linear has used one, `prosemirror`. */
  roots: string[];
  content: YjsNode[];
}

/** Attribute and mark keys whose values are ids or user references. */
const VOLATILE_KEYS = new Set(['id', 'uploadId', 'userId']);

export interface SummaryOptions {
  /** Rewrites a string value, for example an uploaded asset URL back to its source path. */
  mapString?: (value: string) => string;
}

export function summarizeContentState(base64: string, options: SummaryOptions = {}): YjsSummary {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Buffer.from(base64, 'base64'));
  const roots = [...doc.share.keys()].sort();
  const fragment = doc.getXmlFragment('prosemirror');
  const mapString = options.mapString ?? ((value: string) => value);
  return { roots, content: fragment.toArray().flatMap((child) => toNodes(child, mapString)) };
}

function toNodes(item: unknown, mapString: (value: string) => string): YjsNode[] {
  if (item instanceof Y.XmlText) {
    const delta = item.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>;
    return delta.map((run) => {
      const text = typeof run.insert === 'string' ? run.insert : JSON.stringify(run.insert);
      const marks = run.attributes ? normalizeMarks(run.attributes, mapString) : undefined;
      return marks ? { text, marks } : { text };
    });
  }
  if (item instanceof Y.XmlElement) {
    const node: { type: string; attrs?: Record<string, unknown>; children?: YjsNode[] } = { type: item.nodeName };
    const attrs = item.getAttributes() as Record<string, unknown>;
    if (Object.keys(attrs).length > 0) node.attrs = normalizeRecord(attrs, mapString);
    const children = item.toArray().flatMap((child) => toNodes(child, mapString));
    if (children.length > 0) node.children = children;
    return [node];
  }
  return [];
}

/** y-prosemirror may store a mark as `name--hash` so overlapping marks of one type can coexist. */
function normalizeMarks(attributes: Record<string, unknown>, mapString: (value: string) => string): Record<string, unknown> {
  const marks: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) marks[key.replace(/--.*$/, '')] = normalizeValue(key, value, mapString);
  return sortKeys(marks);
}

function normalizeRecord(record: Record<string, unknown>, mapString: (value: string) => string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) result[key] = normalizeValue(key, value, mapString);
  return sortKeys(result);
}

function normalizeValue(key: string, value: unknown, mapString: (value: string) => string): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (VOLATILE_KEYS.has(key)) return `<${key}>`;
  if (typeof value === 'string') return mapString(value);
  if (Array.isArray(value)) return value.map((entry) => normalizeValue('', entry, mapString));
  if (typeof value === 'object') return normalizeRecord(value as Record<string, unknown>, mapString);
  return value;
}

function sortKeys(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/** Counts node types, marks and attribute names in a summary, for the report. */
export function describeSummary(summary: YjsSummary): string[] {
  const parts = new Set<string>();
  const visit = (nodes: YjsNode[]) => {
    for (const node of nodes) {
      if ('text' in node) {
        for (const mark of Object.keys(node.marks ?? {})) if (mark !== 'attribution') parts.add(`mark:${mark}`);
        continue;
      }
      const attrs = Object.entries(node.attrs ?? {})
        .filter(([, value]) => value !== null && value !== '' && value !== false)
        .map(([key]) => key);
      parts.add(attrs.length > 0 ? `${node.type}(${attrs.join(',')})` : node.type);
      visit(node.children ?? []);
    }
  };
  visit(summary.content);
  return [...parts].sort();
}

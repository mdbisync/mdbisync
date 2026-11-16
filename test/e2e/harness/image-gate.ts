// The pull-side image gate through the API path (L2-42): what the harness
// writes into a synced document, where that image sits in Linear's own
// text, and what the sync's notice says about it.
//
// The expected place and line are read from the text Linear stored after
// the harness's write, before any sync ran, so they do not come from the
// result being checked. The notice line is read back from Linear's comments.
import { line, parse, visit } from '../../../src/format/markdown.ts';
import type { LinearClient } from '../../../src/linear/index.ts';
import { IMAGE_BLOCKED_COMMENT } from '../../../src/sync/marks.ts';

/** An image's place among a document's images and its Markdown line, as a notice names it. */
export interface ImagePlace {
  image: number;
  total: number;
  line: number;
}

/**
 * The images of a Markdown text in document order (inline and
 * reference-style, as a reader sees them), each with its alt text and line.
 */
export function imagesIn(text: string): Array<{ alt: string; url: string; line: number }> {
  const tree = parse(text);
  const definitions = new Map<string, string>();
  visit(tree, (node) => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });
  const images: Array<{ alt: string; url: string; line: number }> = [];
  visit(tree, (node) => {
    if (node.type === 'image') images.push({ alt: node.alt ?? '', url: node.url, line: line(node) });
    else if (node.type === 'imageReference') images.push({ alt: node.alt ?? '', url: definitions.get(node.identifier) ?? '', line: line(node) });
  });
  return images;
}

/**
 * Where the image whose alt text holds `token` sits in `text`. Linear may
 * keep the written path or turn it into an upload of its own, so the image
 * is found by its alt text, not its destination. Null when it is not there.
 */
export function imagePlace(text: string, token: string): (ImagePlace & { url: string }) | null {
  const images = imagesIn(text);
  const index = images.findIndex((image) => image.alt.includes(token));
  if (index === -1) return null;
  const found = images[index]!;
  return { image: index + 1, total: images.length, line: found.line, url: found.url };
}

/**
 * What Linear stored where the harness wrote a relative image path: the path
 * kept, an upload of Linear's own, or something else. Only the kind is kept,
 * never the destination: an upload URL is signed.
 */
export type StoredDestination = 'relative-path' | 'upload' | 'other';

/** Where the blocked image points in the text the sync read, and for an upload, the HTTP status it answers. */
export interface ImageGateRecord {
  storedDestination: StoredDestination;
  /** The status of the same authenticated GET the sync makes for an upload; null when the request failed. */
  uploadStatus?: number | null;
}

export function destinationKind(url: string): StoredDestination {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // No scheme: a path. A path from the root or a protocol-relative URL is not the relative path the harness wrote.
    return url.startsWith('/') || url.startsWith('\\') ? 'other' : 'relative-path';
  }
  return parsed.protocol === 'https:' && parsed.hostname === 'uploads.linear.app' && parsed.username === '' && parsed.password === '' && parsed.port === '' ? 'upload' : 'other';
}

/**
 * The record of the blocked image whose alt text holds `token` in `text`.
 * For an upload, the app fetches it as the sync does (its transport's
 * authenticated upload GET, redirects not followed) and keeps the status
 * alone. Null when the image is not in the text.
 */
export async function imageGateRecord(app: Pick<LinearClient, 'transport'>, text: string, token: string): Promise<ImageGateRecord | null> {
  const place = imagePlace(text, token);
  if (place === null) return null;
  const storedDestination = destinationKind(place.url);
  if (storedDestination !== 'upload') return { storedDestination };
  try {
    const response = await app.transport.fetchUpload(place.url, { signal: AbortSignal.timeout(30_000) });
    await response.body?.cancel().catch(() => {});
    return { storedDestination, uploadStatus: response.status };
  } catch {
    // The error could quote the URL: only that the request failed is kept.
    return { storedDestination, uploadStatus: null };
  }
}

/** The label a notice gives an image: `Image N of M (line L)`. */
export function placeLabel(place: ImagePlace): string {
  return `Image ${place.image} of ${place.total} (line ${place.line})`;
}

/** The image labels the sync's image notices list, in the order the comments give them. */
export function noticeImageLabels(comments: readonly string[]): string[] {
  return comments
    .filter(isImageNotice)
    .flatMap((comment) => [...comment.matchAll(/^- (Image \d+ of \d+ \(line \d+\)):/gm)].map((match) => match[1] as string));
}

/** A comment the sync posted because some images of the document cannot be synchronized. */
export function isImageNotice(body: string): boolean {
  return body.includes(IMAGE_BLOCKED_COMMENT);
}

/**
 * `text` without the line that holds the image whose alt text holds `token`, and without the blank line
 * before it, so the rest of the text keeps its bytes; null when there is no such image.
 */
export function withoutImage(text: string, token: string): string | null {
  const place = imagePlace(text, token);
  if (place === null) return null;
  const lines = text.split('\n');
  const at = place.line - 1;
  const blankBefore = at > 0 && lines[at - 1]?.trim() === '';
  lines.splice(blankBefore ? at - 1 : at, blankBefore ? 2 : 1);
  return lines.join('\n');
}

/** A document's comments, with whether each is resolved; the sync resolves an image notice once the images are fixed. */
export async function commentsWithState(app: Pick<LinearClient, 'request'>, id: string): Promise<Array<{ body: string; resolvedAt: string | null }>> {
  const data = await app.request<{ document: { comments: { nodes: Array<{ body: string; resolvedAt: string | null; createdAt: string }> } } | null }>(
    'DocumentComments', 'query', 'query DocumentComments($id: String!) { document(id: $id) { comments(first: 100) { nodes { body resolvedAt createdAt } } } }', { id },
  );
  return (data.document?.comments.nodes ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(({ body, resolvedAt }) => ({ body, resolvedAt }));
}

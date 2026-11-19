// The pull-side image gate through the API path (L2-42): what the harness
// writes into a synced document, where that image sits in Linear's own
// text, and what the sync's notice says about it.
//
// The expected place and line are read from the text Linear stored after
// the harness's write, before any sync ran, so they do not come from the
// result being checked. The notice line is read back from Linear's comments.
import { line, parse, visit } from '../../../src/format/markdown.ts';
import type { LinearClient } from '../../../src/linear/index.ts';
import { isUpload } from '../../../src/sync/assets.ts';
import { IMAGE_BLOCKED_COMMENT } from '../../../src/sync/marks.ts';
import { TYPED_IMAGE_URL } from '../../scenarios/schema.ts';

/** An image's place among a document's images and its Markdown line, as a notice names it. */
export interface ImagePlace {
  image: number;
  total: number;
  line: number;
}

/**
 * The images of a Markdown text in document order (inline and
 * reference-style, as a reader sees them), each with its alt text, line
 * the offset of its `!` in `text`, and whether it is inline (not a reference).
 */
export function imagesIn(text: string): Array<{ alt: string; url: string; line: number; offset: number; inline: boolean }> {
  const tree = parse(text);
  const definitions = new Map<string, string>();
  visit(tree, (node) => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });
  const images: Array<{ alt: string; url: string; line: number; offset: number; inline: boolean }> = [];
  visit(tree, (node) => {
    const offset = node.position?.start.offset ?? -1;
    if (node.type === 'image') images.push({ alt: node.alt ?? '', url: node.url, line: line(node), offset, inline: true });
    else if (node.type === 'imageReference') images.push({ alt: node.alt ?? '', url: definitions.get(node.identifier) ?? '', line: line(node), offset, inline: false });
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
 * What Linear stored where the harness wrote a relative image path: that
 * path kept as written, an upload of Linear's own, or something else (a
 * changed or emptied path, another host). Only the kind is kept, never the
 * destination: an upload URL is signed.
 */
export type StoredDestination = 'relative-path' | 'upload' | 'other';

/** Where the blocked image points in the text the sync read, and for an upload, the HTTP status it answers. */
export interface ImageGateRecord {
  storedDestination: StoredDestination;
  /**
   * The HTTP status of the same authenticated GET the sync's download makes; null when the request failed.
   * The status alone: the sync's size and type checks on the body are not applied.
   */
  uploadStatus?: number | null;
}

/** The relative image path the `linear.image-path` step writes. */
export function writtenImagePath(token: string): string {
  return `../images/plan-${token}.png`;
}

/** The kind of `url`, an image destination Linear stored where the harness wrote `written`. */
export function destinationKind(url: string, written: string): StoredDestination {
  if (isUpload(url)) return 'upload';
  return url === written ? 'relative-path' : 'other';
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
  const storedDestination = destinationKind(place.url, writtenImagePath(token));
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

/** A document's comments, with whether each is resolved; the sync leaves an image notice open once the images are fixed, as the record of the finding. */
export async function commentsWithState(app: Pick<LinearClient, 'request'>, id: string): Promise<Array<{ body: string; resolvedAt: string | null }>> {
  const data = await app.request<{ document: { comments: { nodes: Array<{ body: string; resolvedAt: string | null; createdAt: string }> } } | null }>(
    'DocumentComments', 'query', 'query DocumentComments($id: String!) { document(id: $id) { comments(first: 100) { nodes { body resolvedAt createdAt } } } }', { id },
  );
  return (data.document?.comments.nodes ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(({ body, resolvedAt }) => ({ body, resolvedAt }));
}


/** Independent input and expected link body recorded before the sync runs. */
export interface ImageRepairSource extends ImagePlace {
  path: string;
  token: string;
  body: string;
  expected: string;
  icon: string | null;
  color: string | null;
}

/** What the two sides and proposal show before its merge. */
export interface ImageRepairProposal {
  content: string;
  recorded: string;
  proposed: string;
  icon: string | null;
  color: string | null;
  comments: string[];
  number: number;
  description: string;
}

// --- an external image typed in Linear's editor (L6-14) ----------------------------------------

/** What a person types in the editor: an image whose alt text names the run, so the harness finds it. */
export interface TypedImage {
  alt: string;
  url: string;
  markdown: string;
}

/** The image `ui.type-external-image` asks the person to type, from its `imageUrl` argument and the run's id. */
export function typedImage(args: Record<string, unknown>, runId: string): TypedImage {
  const url = args.imageUrl;
  if (typeof url !== 'string' || !TYPED_IMAGE_URL.test(url)) throw new Error(`ui.type-external-image needs an imageUrl that matches ${String(TYPED_IMAGE_URL)}`);
  const alt = `harbor map ${runId}`;
  return { alt, url, markdown: `![${alt}](${url})` };
}

/**
 * What Linear stored for the typed image: the external image as typed, an upload of Linear's own, another image
 * destination, no image although the typed URL or alt text is there (a link or plain text), or nothing of the typing
 * by the wait's end (Linear dropped the image or never saved the typing). Only the kind is kept, never the
 * destination: an upload URL is signed.
 */
export type TypedImageStored = 'external' | 'upload' | 'other-image' | 'not-an-image' | 'not-observed';

/** The typed image's record in the run's result. */
export interface TypedImageRecord {
  stored: TypedImageStored;
}

/**
 * The typed image in `text` and what Linear made of it; null while the text holds neither the image nor its URL
 * or alt text (Linear has not saved the typing yet). The image is found by its URL, failing that by its alt text,
 * since Linear may store an upload of its own in its place, and failing both, as the last image when the text holds
 * more than the `imagesBefore` the document had before the typing (an upload with the alt text dropped): the person
 * types at the end of the document. `inline` is false for a reference-style image.
 */
export function findTypedImage(text: string, typed: TypedImage, imagesBefore: number): { stored: TypedImageStored; place?: ImagePlace & { offset: number; inline: boolean } } | null {
  const images = imagesIn(text);
  let index = images.findIndex((image) => image.url === typed.url);
  if (index === -1) index = images.findIndex((image) => image.alt.includes(typed.alt));
  if (index === -1 && images.length > imagesBefore) index = images.length - 1;
  if (index === -1) return text.includes(typed.url) || text.includes(typed.alt) ? { stored: 'not-an-image' } : null;
  const found = images[index]!;
  const stored: TypedImageStored = found.url === typed.url ? 'external' : isUpload(found.url) ? 'upload' : 'other-image';
  return { stored, place: { image: index + 1, total: images.length, line: found.line, offset: found.offset, inline: found.inline } };
}

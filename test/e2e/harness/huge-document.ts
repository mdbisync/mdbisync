// L5-22: a document longer than Linear's API accepts. The API refuses content
// over `LINEAR_FACTS.maxContentLength` code points on create and on update
// alike (each write sends the whole content), so no API route, appending
// included, makes such a document. Only Linear's editor can. The harness
// writes the exact text into the run folder when the run is held for the UI
// session; the session pastes it into a new document in the run's project;
// `linear.await-huge-document` then finds that document and checks that
// Linear stored more than the API would take. A document Linear did not store
// over the limit, or not the text as prepared, leaves the precondition unmet:
// no shorter or changed stand-in counts.
import { createHash } from 'node:crypto';
import { LINEAR_FACTS, linearLength } from '../../../src/linear/facts.ts';
import { noteSentence } from './conflicts.ts';

/** The file in the run folder that holds the text to paste. */
export const HUGE_DOCUMENT_FILE = 'huge-document.txt';

/** The paragraph repeated to fill the text: plain words and a full stop, nothing Markdown would change. */
const FILLER = 'Plain text line for the large notes page.';

export interface HugeDocument {
  /** The new document's title in Linear. */
  title: string;
  /** The text's first paragraph carries it, so the harness tells the pasted text from any other. */
  token: string;
  /** The text to paste: `characters` code points of ASCII, in paragraphs. */
  text: string;
  sha256: string;
}

/** The document `ui.create-huge-document` asks for, the same for the checklist and the harness step that follows. */
export function hugeDocument(args: Record<string, unknown>, runId: string): HugeDocument {
  const characters = args.characters;
  if (typeof characters !== 'number' || !Number.isInteger(characters) || characters <= LINEAR_FACTS.maxContentLength) {
    throw new Error(`ui.create-huge-document needs a whole number of characters over Linear's API limit of ${LINEAR_FACTS.maxContentLength}`);
  }
  const token = `${runId}-large`;
  const head = `${noteSentence(token)}\n\n`;
  const paragraph = `${FILLER}\n\n`;
  const full = head + paragraph.repeat(Math.ceil((characters - head.length) / paragraph.length));
  // Cut to the exact length; a cut that ends in whitespace ends in a full stop instead, since an editor drops it.
  const cut = full.slice(0, characters);
  const text = cut.replace(/\s+$/, (space) => '.'.repeat(space.length));
  return { title: `large-notes-${runId}`, token, text, sha256: createHash('sha256').update(text).digest('hex') };
}

/** What Linear stored for the pasted document, in the run's result: lengths and whether it is the text as prepared, never the text. */
export interface HugeDocumentRecord {
  prepared: number;
  stored: number;
  sameAsPrepared: boolean;
}

/**
 * Why a document Linear stored does not meet L5-22's precondition, with lengths only; undefined when it does: the
 * text as prepared (final whitespace aside, which an editor drops), so over the API's limit. A paste that lost text
 * anywhere is not the requested document, even when what is left is still over the limit.
 */
export function hugeDocumentShortfall(content: string, prepared: HugeDocument): string | undefined {
  const stored = linearLength(content);
  if (stored <= LINEAR_FACTS.maxContentLength) return `Linear stored ${stored} code points, not over the API limit of ${LINEAR_FACTS.maxContentLength}`;
  if (!hugeDocumentRecord(content, prepared).sameAsPrepared) return `Linear stored ${stored} code points that are not the prepared text of ${linearLength(prepared.text)}`;
  return undefined;
}

export function hugeDocumentRecord(content: string, prepared: HugeDocument): HugeDocumentRecord {
  return { prepared: linearLength(prepared.text), stored: linearLength(content), sameAsPrepared: content.trimEnd() === prepared.text.trimEnd() };
}

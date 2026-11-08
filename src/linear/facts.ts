// Facts about Linear that the engine depends on. The format probe
// (`npm run probe:format`) measures them against a live workspace; the values
// below are from its full run of 2026-11-08 (271 fixtures). A later probe run
// that measures something else changes them here.

export interface LinearFacts {
  /**
   * Whether `documentCreate` and `documentUpdate` return the stored
   * (normalized) content in their payload. When true, a write needs no
   * read-back request. Measured: the payload equalled the stored content for
   * 270 of 270 creates and 270 of 270 updates.
   */
  readonly mutationsReturnStoredContent: boolean;
  /**
   * Longest document title Linear accepts, counted like content (see
   * `linearLength`). Measured: 512 accepted, 513 refused with INVALID_INPUT.
   */
  readonly maxTitleLength: number;
  /**
   * Largest document content Linear accepts, in Unicode code points.
   * Measured: 250,000 accepted, 250,001 refused with INVALID_INPUT; 125,001
   * emoji (250,002 UTF-16 units) accepted, 250,001 emoji refused.
   */
  readonly maxContentLength: number;
  /**
   * Whether a team filter on `documents` also returns the team's project
   * documents. Measured: it does not, and a project document's `team` field
   * is null, so a team filter returns exactly the team zone.
   */
  readonly teamFilterIncludesProjectDocuments: boolean;
}

export const LINEAR_FACTS: LinearFacts = Object.freeze({
  mutationsReturnStoredContent: true,
  maxTitleLength: 512,
  maxContentLength: 250_000,
  teamFilterIncludesProjectDocuments: false,
});

/** A text's length as Linear counts it for its limits: Unicode code points. */
export function linearLength(text: string): number {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

/** A title or content longer than Linear accepts; such a document is left out, never sent. */
export interface LengthRefusal {
  field: 'title' | 'content';
  length: number;
  limit: number;
}

/** Why Linear would refuse this title or content for its length, or undefined when both fit. */
export function lengthRefusal(
  document: { title?: string | undefined; content?: string | undefined },
  facts: LinearFacts = LINEAR_FACTS,
): LengthRefusal | undefined {
  // Cheap check first: a string never has more code points than UTF-16 units.
  const over = (text: string | undefined, limit: number) => {
    if (text === undefined || text.length <= limit) return undefined;
    const length = linearLength(text);
    return length > limit ? length : undefined;
  };
  const title = over(document.title, facts.maxTitleLength);
  if (title !== undefined) return { field: 'title', length: title, limit: facts.maxTitleLength };
  const content = over(document.content, facts.maxContentLength);
  if (content !== undefined) return { field: 'content', length: content, limit: facts.maxContentLength };
  return undefined;
}

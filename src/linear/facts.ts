// Facts about Linear that the engine depends on and that the format probe
// measures (MDS-005-4). Until the probe's report exists, each unknown fact is
// `undefined` and callers take the safe path.

export interface LinearFacts {
  /**
   * Whether `documentCreate` and `documentUpdate` return the stored (normalized)
   * content in their payload. When true, a write needs no read-back request.
   * TODO(MDS-005-4): set from the format report.
   */
  mutationsReturnStoredContent: boolean | undefined;
  /** Longest document title Linear accepts. TODO(MDS-005-4): from the format report. */
  maxTitleLength: number | undefined;
  /** Largest document content Linear accepts, in characters. TODO(MDS-005-4): from the format report. */
  maxContentLength: number | undefined;
  /**
   * Whether a team filter on `documents` also returns the team's project
   * documents, or only those without a project (the team zone).
   * TODO(MDS-005-4): from the format report.
   */
  teamFilterIncludesProjectDocuments: boolean | undefined;
}

export const LINEAR_FACTS: LinearFacts = {
  mutationsReturnStoredContent: undefined,
  maxTitleLength: undefined,
  maxContentLength: undefined,
  teamFilterIncludesProjectDocuments: undefined,
};

// Where each reason a run stopped before writing is fixed: a section of the
// quickstart. Every failure message carries its link, so a person reading a
// failed job goes straight to the step that fixes it.

import { PROJECT_URL } from '../version.ts';
import { type FailureCode } from './report.ts';

export const QUICKSTART_PATH = 'docs/quickstart.md';
// The default branch, not the running release: a release commit carries
// the action and hooks only, not the docs. The anchors stay stable.
export const QUICKSTART_URL = `${PROJECT_URL}/blob/main/${QUICKSTART_PATH}`;

/** The quickstart section (its heading's anchor) that fixes each failure. */
export const FIX_ANCHORS: Readonly<Record<FailureCode, string>> = {
  'linear-credential-failed': 'linear-oauth-app',
  'linear-teams-not-visible': 'linear-oauth-app',
  'github-credential-failed': 'github-app',
  'missing-permission': 'github-app',
  'merge-commits-required': 'merge-commits',
  'linear-format-hook-required': 'linear-format-hook',
  'invalid-annotation': 'folder-annotations',
  'no-annotations': 'folder-annotations',
  'annotation-target-not-found': 'folder-annotations',
  'annotation-target-ambiguous': 'folder-annotations',
  'annotation-target-shared': 'folder-annotations',
  'initial-sync-required': 'initial-sync',
  'initial-pull-request-pending': 'initial-sync',
};

/** The link to the quickstart section that fixes `code`, or undefined for a code that is not a setup failure. */
export function fixUrl(code: string | undefined): string | undefined {
  if (code === undefined || !Object.hasOwn(FIX_ANCHORS, code)) return undefined;
  return `${QUICKSTART_URL}#${FIX_ANCHORS[code as FailureCode]}`;
}

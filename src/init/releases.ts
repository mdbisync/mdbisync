// `init` writes the workflow templates pinned to the release SHA it is
// given. The templates are written for, and checked against, the release
// they pin; an older release's action may lack inputs they pass (rc.6 and
// earlier do). `init` works offline and cannot read a release's
// `action.yml`; it knows the older releases by SHA instead. A SHA it does
// not know (a later release, or a build of your own) is written as given.
import olderReleases from './older-releases.json' with { type: 'json' };
import templates from './workflows.json' with { type: 'json' };

/** A template's pin of the action: the release SHA and its version comment. */
export const RELEASE_PIN = /mdbisync\/mdbisync@([a-f0-9]{40}) # (v\S+)/;

/**
 * The release the templates pin: the oldest one `init` writes. Every
 * template pins the same release; `test/workflows/release-pin.test.ts`
 * checks that.
 */
const pinned = RELEASE_PIN.exec(templates['mdbisync.yml']);
export const MINIMUM_RELEASE = { sha: pinned?.[1] ?? '', version: pinned?.[2] ?? '' };

/**
 * Every release before MINIMUM_RELEASE, by release SHA. A release's
 * `pins` job rewrites this file together with the templates' pins
 * (`src/release/pins.ts`); `test/workflows/release-pin.test.ts` checks it
 * against the tags.
 */
export const OLDER_RELEASES: Readonly<Record<string, string>> = olderReleases;

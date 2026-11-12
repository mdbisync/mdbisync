// `init` writes the workflow templates pinned to the release SHA it is
// given. The templates are written for, and checked against, the release
// they pin; an older release's action may lack inputs they pass (rc.6 and
// earlier do). `init` works offline and cannot read a release's
// `action.yml`; it knows the older releases by SHA instead. A SHA it does
// not know (a later release, or a build of your own) is written as given.
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
 * Every release before MINIMUM_RELEASE, by release SHA. When the templates
 * move to a later release, add the releases in between;
 * `test/workflows/release-pin.test.ts` checks this list against the tags.
 */
export const OLDER_RELEASES: Readonly<Record<string, string>> = {
  c0ee458e4ceac001cf6114a1bffa443d67941298: 'v0.1.0-rc.1',
  '79db9969462ae7f1f00c88e95b311e61db3c455e': 'v0.1.0-rc.2',
  b015b1cb6e739b5f40c1ae17812779c433d111f9: 'v0.1.0-rc.3',
  e290a1138e0c769b57ea93e345f63bd00c2575a1: 'v0.1.0-rc.4',
  d7d1f9f0acc5677574bf7b77e41ffb3c52e5377f: 'v0.1.0-rc.5',
  e4e305d00c35414b19ecf2996504b6f9ab622c4c: 'v0.1.0-rc.6',
  d5655bd74239d88d4323957d0945163678698858: 'v0.1.0-rc.7',
  '92a1d9ecd9c89ff18703c9d4f8476d9e3702170e': 'v0.1.0-rc.8',
};

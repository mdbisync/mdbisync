| Status | Complete |
| -- | -- |
| Date | 2026-07-08 |
| Authors | DemoMike, DemoNina |
| Led to | [RFC-072 Weekly app releases](@RFC-072) |

## Question

How stable were the twelve app releases of the first half of 2026, and what did the less stable ones have in common?

## Method

* Crash-free sessions per release over its first 14 days at 100 % rollout, from the crash reporter in both apps.
* A session counts as crashed if the app terminated unexpectedly while in the foreground; out-of-memory kills on iOS are included.
* For each release we recorded the testing days between branch cut and store submission, and whether a hotfix of the previous release fell into that time.

## Results

@@picture:rn-062-crash-free@@

@@table:rn-062-crash-free@@

@@csv:rn-062-crash-free@@

| Release | Testing days | Hotfix during testing | Largest new crash |
| -- | -- | -- | -- |
| 5.3 | 3 | yes, 5.2.1 | Android: image cache on low memory |
| 5.8 | 2 | yes, 5.7.2 | Android: background sync after process death |
| Other ten | 5 | no | none above 200 users |

## Findings

* Crash-free sessions improved steadily: from 99.82 % to 99.92 % on iOS, and from 99.61 % to 99.80 % on Android.
* The two dips, 5.3 and 5.8, are the two releases whose testing was cut to two or three days by a hotfix. Their new crashes were both on Android, both in code paths that run when the system kills the app in the background, which the shortened checklist skipped.
* No release fell below 99.4 %, and no rollout had to be halted.

> [!WARNING]
> Shorter testing, not more changes, explains both dips. A faster train would shorten testing for every release.

## Recommendation

Keep five testing days per release. Add process-death checks on Android to the release checklist ([SPEC-075](@SPEC-075)) and do not cut a release's testing for a hotfix of the previous one; ship the hotfix from its own branch. This evidence led to rejecting [RFC-072](@RFC-072).

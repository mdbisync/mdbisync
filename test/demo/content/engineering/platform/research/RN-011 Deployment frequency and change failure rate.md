| Status | Complete |
| -- | -- |
| Date | 2026-10-13 |
| Authors | DemoKen, DemoMike |
| Follows | [ADR-032 Adopt trunk-based development](@ADR-032) |

## Question

Did the delivery changes of the last seven quarters (trunk-based development, canaries, the release gate) make us ship more often without breaking more?

## Method

* All production deploys from January 2025 to September 2026, from Argo CD history.
* A deploy "failed" if it caused a customer-visible problem: an alert that paged, a rollback, or a fix deployed within 24 hours for the same change.
* Changes in the period: canary releases from Q4 2025 ([RFC-001](@RFC-001)), trunk-based development from Q1 2026 ([ADR-032](@ADR-032)), load tests and the release gate from Q2 2026 ([SPEC-003](@SPEC-003)).

## Results

@@picture:rn-011-frequency@@

@@picture:rn-011-failure@@

@@table:rn-011-failure@@

@@csv:rn-011-failure@@

## Findings

* Deploys per week more than doubled, from 38 to 84.
* The change failure rate fell by two thirds, from 6.1 % to 2.0 %. The largest drop came with canaries (Q4 2025), which stop bad releases before most buyers see them.
* Trunk-based development raised frequency the most: smaller changes, merged daily.
* Median lead time from merge to production fell from 3.1 hours to 52 minutes.

## Recommendation

Keep the current pipeline. The next gains are in catching slow failures (memory leaks, slow queries) that canaries miss ([RN-001](@RN-001)).

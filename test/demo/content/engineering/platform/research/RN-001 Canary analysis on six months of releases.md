| Status | Complete |
| -- | -- |
| Date | 2026-06-16 |
| Authors | DemoErin, DemoKen |
| Follows | [RFC-001 Progressive delivery with canary releases](@RFC-001) |

## Question

Do canary releases with automatic analysis catch bad releases early enough, and how often do they stop a good release by mistake?

## Method

* All 497 production releases of canary services from December 2025 to May 2026.
* A release counts as bad if it caused a customer-visible problem or was rolled back by hand within 24 hours.
* We replayed each release's canary metrics against the limits of [SPEC-012](@SPEC-012) to separate true and false stops.
* Time to roll back: from the first failed request to traffic back on stable.

## Results

@@picture:rn-001-rollback-time@@

@@picture:rn-001-releases@@

@@table:rn-001-releases@@

@@csv:rn-001-releases@@

| Outcome | Releases |
| -- | -- |
| Good, promoted | 482 |
| Good, stopped by the analysis (false stop) | 4 |
| Bad, stopped by the analysis | 9 |
| Bad, not stopped (found by people) | 2 |

## Findings

* The analysis stopped 9 of the 11 bad releases. Both misses were slow memory leaks that showed only after hours, outside a 30-minute canary.
* Median time to roll back fell from 23 minutes to 1.2 minutes, because nobody has to notice first.
* 4 false stops in 486 good releases (0.8 %). Three were night releases of low-traffic services before the 20-minute night windows existed.
* A canary release takes 35 minutes instead of 6. Teams did not release less often: 497 releases against 431 in the six months before ([RN-011](@RN-011)).

## Recommendation

Keep the limits. Add a memory growth check that compares canary and stable memory per request over the last step, and extend the last step to 20 minutes for services with a history of leaks.

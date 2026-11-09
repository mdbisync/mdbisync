| Status | Complete |
| -- | -- |
| Date | 2026-09-29 |
| Authors | DemoAlice, DemoKen |
| Follows | [ADR-048 Run checkout active-passive across two regions](@ADR-048) |

## Question

Can we move checkout to the standby region within the targets of [RFC-015](@RFC-015): 15 minutes to recover, at most 1 minute of orders lost?

## Method

* Planned drill in production on Tuesday 22 September 2026 at 06:00, the quietest hour of the week.
* Region A's checkout path was cut off at the network level, as in a regional failure.
* The on-call engineer followed the failover steps with the failover command; observers timed each step.
* Orders lost: orders committed in region A and missing in region B after promotion.

## Results

@@picture:rn-014-drill@@

@@table:rn-014-drill@@

| Measure | Target | Result |
| -- | -- | -- |
| Recovery time | 15 min | 11 min |
| Replication lag at the cut | under 60 s | 9 s |
| Orders lost | at most 1 minute's worth | 0 (none placed in those 9 s) |
| Checkout errors during the switch | | 2,140 failed attempts, 61 % retried successfully |

## Findings

* The longest step was scaling services in region B from standby size to production size: 3.5 minutes, waiting for nodes.
* DNS switched in 1.5 minutes; some mobile networks held the old record for up to 5 minutes, but region A refused connections, so clients retried.
* Order events written in region A in the last seconds were published again from the outbox after the switch ([ADR-014](@ADR-014)); consumers deduplicated them ([SPEC-016](@SPEC-016)).

## Recommendation

Keep 4 more warm nodes in region B to cut the scale-up step to about 1 minute, and run the drill every quarter, alternating staging and production.

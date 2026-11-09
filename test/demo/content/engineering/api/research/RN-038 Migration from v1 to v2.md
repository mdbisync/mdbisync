| Status | Complete |
| -- | -- |
| Date | 2026-07-07 |
| Authors | DemoErin, DemoPeggy |
| Led to | Closing [ADR-044 Retire public API v1 by June 2026](@ADR-044) |

## Question

Did partners move from v1 to v2 in time for the retirement on 2026-06-30, what helped them move, and what broke on the day?

## Method

* Monthly share of partner traffic per version from gateway logs, November 2025 to June 2026.
* Count of partners that made at least one v1 call in the first week of each month.
* Effect of the two brownouts ([RFC-037](@RFC-037)): partners that called v1 during a brownout window and how many of them had moved a month later.
* Support tickets tagged with the migration.

## Results

@@picture:rn-038-v2-share@@

@@table:rn-038-v2-share@@

@@picture:rn-038-partners@@

@@table:rn-038-partners@@

@@csv:rn-038-partners@@

| Event | Partners calling v1 in the window | Of those, on v2 a month later |
| -- | -- | -- |
| Brownout of 1 hour, 2026-05-12 | 39 | 33 |
| Brownout of 4 hours, 2026-06-02 | 14 | 12 |

## Findings

* **v2 reached 99.6 % of traffic in June**, and no partner called v1 in July.
* **The SDKs drove the middle of the curve.** The steepest months, February to April, follow the SDK releases ([RFC-035](@RFC-035)); 71 % of partners that moved in those months moved onto an SDK.
* **Brownouts found the forgotten clients.** 39 partners still called v1 during the first brownout, most from scripts their own teams had forgotten; 33 of them moved within a month.
* **Retirement day was quiet:** 12 partners got `410 Gone`, all of them had been told six times. Support received 9 tickets in the following week.
* Client errors fell with the move: v2 runs at about 1.2 % against v1's 5 % ([RN-033](@RN-033)).

> [!NOTE]
> The v1 timeline was shorter than the 12 months of the deprecation policy. It held because of direct notices and brownouts, not because of the date itself.

## Recommendation

* Keep brownouts in the deprecation policy; they did more than the reminder notices.
* Switch the retired paths from `410` to `404` on 2026-09-28 as planned ([SPEC-042](@SPEC-042)).
* Remove the v1 adapters from `api-gateway` and close [ADR-044](@ADR-044).

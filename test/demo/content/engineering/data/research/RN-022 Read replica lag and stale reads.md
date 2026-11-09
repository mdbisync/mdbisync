| Status | Complete |
| -- | -- |
| Date | 2026-10-20 |
| Authors | DemoKen |
| Led to | [RFC-022 Read replicas for catalog reads](@RFC-022) |

## Question

How far behind would read replicas of the catalog database fall during a sale, and how many product page reads would see a price or stock older than the 2-second bound that [RFC-022](@RFC-022) proposes?

## Method

* One asynchronous streaming replica of the production catalog database, the same instance size as the primary, during the October 2026 sale day, 2026-10-14.
* Replay lag sampled every second from `pg_stat_replication`; the chart shows p50 and p99 over each 2-hour window.
* For stale reads, we replayed 1 % of that day's product page queries against the replica, recorded each row's `updated_at`, and compared with the primary's.
* Nobody was served from the replica; it only received queries.

## Results

@@picture:rn-022-lag@@

@@table:rn-022-lag@@

@@csv:rn-022-lag@@

## Findings

* Outside the sale peak, p99 replay lag stayed between 120 and 180 ms.
* During the peak from 18:00 to 22:00, p99 reached 1,400 ms; the longest single lag was 3.1 s, during a bulk price import.
* Of the replayed product page reads, 0.31 % returned a row older than the primary's; 0.02 % were more than 2 seconds old, all during the bulk import.
* With the 2-second guard of [RFC-022](@RFC-022), the replica would have left the pool for 41 seconds in total that day.
* Replay used 12 % of the replica's CPU at peak; reads would have most of the machine.

## Recommendation

* Two replicas with the 2-second staleness guard, as proposed.
* Keep checkout price checks and stock checks on the primary ([SPEC-054](@SPEC-054)): 0.31 % stale rows is fine for pages, not for money.
* Ask for bulk price imports in batches of at most 1,000 rows, as [RN-020](@RN-020) already recommends for change data capture.

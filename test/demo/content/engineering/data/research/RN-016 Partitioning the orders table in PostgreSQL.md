| Status | Complete |
| -- | -- |
| Date | 2026-02-16 |
| Authors | DemoGrace, DemoMike |
| Led to | [RFC-019 Monthly partitions for the orders table](@RFC-019) |

## Question

Would monthly range partitions make the orders queries that matter faster, and shrink the indexes that must stay in memory, without slowing lookups by order id?

## Method

* A copy of the production `orders` and `order_lines` tables (61 million and 188 million rows) on a staging server of the production size, restored from the backup of 2026-02-02.
* Two layouts: today's single tables, and monthly range partitions on `created_at` built with `pg_partman`.
* Four query shapes taken from `pg_stat_statements`, which together make up 92 % of the database's query time.
* Each query ran 10,000 times with parameters sampled from a day of production traffic, after a warm-up run; we report p95.
* Lookups by id use time bounds derived from the UUIDv7 id, as [RFC-019](@RFC-019) proposes.

## Results

@@picture:rn-016-latency@@

@@table:rn-016-latency@@

@@picture:rn-016-index@@

@@table:rn-016-index@@

Raw measurements:

@@csv:rn-016-latency@@

## Findings

* Every query shape is faster with partitions. Lookups by id dropped from 4.1 ms to 1.2 ms, because the planner prunes to one partition and the partition's index is in memory.
* The scan for open orders, used by fulfilment and reconciliation, fell from 1,900 ms to 310 ms: open orders are almost all in the last two partitions.
* The indexes for the last three months total 6.5 GB against 64 GB for the whole tables, so the hot part fits in the server's 32 GB of shared buffers with room to spare.
* Lookups by id without time bounds touch every partition and take 14 ms. Every code path in `orders-svc` must derive the bounds; a lint rule in the service's query builder enforces it.

> [!WARNING]
> A query that forgets the partition key gets slower, not faster. The query builder refuses lookups on `orders` without `created_at` bounds.

## Recommendation

Partition `orders` and `order_lines` by month, derive time bounds from UUIDv7 ids, and detach partitions after 25 months instead of deleting rows. Proposed in [RFC-019](@RFC-019) and decided in [ADR-037](@ADR-037).

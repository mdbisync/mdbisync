| Status | Complete |
| -- | -- |
| Date | 2026-01-19 |
| Authors | DemoCarol |
| Led to | [SPEC-022 Outbox table layout](@SPEC-022), version 1.2 |

## Question

Our outbox relays poll the `outbox` table every 500 ms. Would tailing the write-ahead log for inserts into `outbox` publish events sooner and take load off the database?

## Method

* The `orders-svc` outbox in staging, fed with a replay of the 2025 November sale peak: 9,000 events per second for 20 minutes.
* Relay A: polls every 500 ms, reads up to 500 unpublished rows, publishes them as one batch, then marks them published.
* Relay B: reads inserts from a logical replication slot and publishes as rows arrive, in batches of at least 100 and at most 500 rows or every 20 ms, whichever comes first.
* Publish delay measured from the transaction's commit to Kafka's acknowledgement; database CPU from the host metrics.

## Results

@@picture:rn-026-delay@@

@@table:rn-026-delay@@

@@picture:rn-026-cpu@@

@@table:rn-026-cpu@@

@@csv:rn-026-delay@@

## Findings

* Log tailing publishes 14 times sooner at the median (18 ms against 260 ms) and about 8 times sooner at p99 (95 ms against 740 ms).
* Both relays publish in batches of 100 to 500 rows at peak, the range where Kafka's latency is lowest ([RN-015](@RN-015)). Polling reaches the 500-row cap at peak, so its batches wait for the next poll.
* Polling used 7.5 % of the database's CPU at peak, mostly for the index scan on unpublished rows and the update of `published_at`. Log tailing used 1.2 %; it still sets `published_at`, but in one statement per batch.
* Log tailing needs a replication slot per service. A stopped relay keeps WAL on the primary, the same risk as with change data capture ([RFC-017](@RFC-017)); the same 20 GB alert covers it.

## Recommendation

Switch relays to log tailing with batches of 100 to 500 rows, keep polling as a fallback the relay can use if its slot is lost, and alert on retained WAL. Written into [SPEC-022](@SPEC-022) version 1.2.

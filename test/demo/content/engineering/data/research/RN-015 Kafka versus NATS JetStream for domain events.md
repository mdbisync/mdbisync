| Status | Complete |
| -- | -- |
| Date | 2025-02-07 |
| Authors | DemoCarol, DemoIvan |
| Led to | [ADR-005 Use Kafka for domain events](@ADR-005) |

## Question

Which event log keeps order events in order per order, lets consumers replay them, and stays under 20 ms at p99 for our peak load of about 9,000 events per second, with room to grow five times?

## Method

* Two candidates: a managed Kafka cluster (3 brokers, 48 partitions) and NATS JetStream (3 nodes, file storage, R3), both in one region on the same instance size.
* Load: 500,000 order events per run, 1.2 KB each on average, replayed from a day of production traffic with customer fields removed.
* Producers sent batches of 1, 10, 50, 100 and 500 events; we measured publish latency at the producer, from send to acknowledgement.
* Each run was repeated five times; the tables show the median run.

## Results

@@picture:rn-015-latency@@

@@table:rn-015-latency@@

@@picture:rn-015-throughput@@

@@table:rn-015-throughput@@

Raw results, one row per batch size:

@@csv:rn-015-latency@@

## Findings

* With small batches JetStream is faster: 8.7 ms against 12.4 ms at p99 for single events.
* From 50 events per batch Kafka pulls ahead, and at 500 events it stays at 14.6 ms while JetStream reaches 21.3 ms. Our outbox relays publish in batches of 100 to 500 ([RN-026](@RN-026)).
* Kafka sustained 48,000 events per second under the 20 ms bound, JetStream 31,000. Both are above today's peak; only Kafka leaves five times headroom.
* Both kept per-key ordering in every run. Both allow replay by position.

> [!NOTE]
> JetStream would need fewer moving parts if we ran it ourselves. With a managed Kafka service available in both regions, the operational argument goes away.

## Recommendation

Use Kafka for domain events, publish in batches of at least 50, and key by aggregate id. Decided in [ADR-005](@ADR-005).

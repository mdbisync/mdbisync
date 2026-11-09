| Status | Complete |
| -- | -- |
| Date | 2025-07-21 |
| Authors | DemoIvan, DemoKen |
| Led to | Go-ahead for [RFC-017 Change data capture with Debezium](@RFC-017) |

## Question

How long does a catalog change take to travel from a commit in PostgreSQL to a change event in Kafka, over a whole day and at the evening peak? Is it short enough to keep search prices current within seconds?

## Method

* Debezium 2.7 with the PostgreSQL connector on two Kafka Connect workers, reading the production catalog database through a replication slot, in shadow mode: events went to a staging topic nobody consumed.
* Lag measured per event as the difference between the commit time in the WAL (`source.ts_ms`) and the Kafka append time, for every event of a full Monday, 2025-07-14.
* 4.3 million row changes that day; peak 410 changes per second at 20:00.
* Retained WAL on the replication slot sampled every minute.

## Results

@@picture:rn-020-lag@@

@@table:rn-020-lag@@

@@csv:rn-020-lag@@

## Findings

* Median lag stays between 120 and 380 ms all day.
* p99 lag rises with load and peaks at 2,400 ms at 20:00, when sellers' inventory jobs update stock in bulk. Even then, a price change reaches Kafka in under 3 seconds.
* The slot never retained more than 1.6 GB of WAL, far under the 20 GB alert threshold of [RFC-017](@RFC-017).
* The connector's snapshot of 9.4 million products took 2 h 40 min and slowed nothing measurably on the primary (CPU plus 3 percentage points).

> [!TIP]
> The p99 peak comes from transactions that update thousands of rows at once. Debezium publishes them only after the commit, so one large bulk job delays the changes queued behind it.

## Recommendation

Proceed with [RFC-017](@RFC-017). Ask sellers' inventory integrations to commit in batches of at most 1,000 rows ([SPEC-080](@SPEC-080)) to keep the p99 below 3 seconds as the catalog grows.

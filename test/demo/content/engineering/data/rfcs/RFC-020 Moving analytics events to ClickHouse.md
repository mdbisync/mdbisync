| Status | Implemented |
| -- | -- |
| Created | 2025-04-22 |
| Authors | DemoNina |
| Reviewers | DemoCarol, DemoGrace |
| Target | Q3 2025 |
| Decision | [ADR-011 Store analytics events in ClickHouse](@ADR-011) |

## Summary

Store analytics events and the analytics copy of domain events in ClickHouse, loaded from Kafka by `events-pipeline`, and retire the PostgreSQL reporting replica.

## Motivation

Analytics events (page views, searches, clicks, add-to-cart) land today in a PostgreSQL table on a reporting replica:

* 2.9 billion rows, 1.1 TB, growing 140 GB a month.
* The daily funnel report scans 30 days and takes 47 minutes.
* Ad-hoc queries time out at 15 minutes; analysts sample 1 % of the data instead.

## Proposal

### Data flow

@@picture:rfc-020-flow@@

* Clients send analytics events to `events-pipeline` over HTTPS; services publish domain events to Kafka as before.
* `events-pipeline` validates each event against the [analytics schema](@SPEC-020), batches them (100,000 rows or 5 seconds) and inserts into ClickHouse.
* Domain events are copied unchanged with their [envelope](@SPEC-016) fields as columns.

### Tables

One wide table for analytics events, ordered for the most common filters, described in [SPEC-025](@SPEC-025):

```sql
CREATE TABLE analytics.events
(
    event_date  Date,
    event_time  DateTime64(3, 'UTC'),
    event_type  LowCardinality(String),
    session_id  UUID,
    platform    LowCardinality(String),
    properties  String CODEC(ZSTD(3))
)
ENGINE = ReplicatedMergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_type, event_date, session_id);
```

### Retention

Raw events stay 13 months ([ADR-027](@ADR-027)); daily aggregates stay 5 years.

## Alternatives

| Option | 30-day funnel query | Storage for 13 months | Why not |
| -- | -- | -- | -- |
| Bigger PostgreSQL replica | about 30 min | 1.8 TB | Still too slow for ad-hoc work |
| Managed cloud warehouse | 20 s | billed per scan | Query costs hard to predict, about 4 times our budget at current use |
| **ClickHouse, 3 nodes** | **4 s** | **190 GB compressed** | Chosen |

## Rollout

- [X] ClickHouse cluster, 3 nodes with 2 replicas each shard
- [X] `events-pipeline` writes to both PostgreSQL and ClickHouse for 4 weeks
- [X] Reports compared: totals within 0.1 % on every day
- [X] Reports switched to ClickHouse
- [X] Reporting replica removed

## Open questions

* Should change data capture feed ClickHouse too? No: ClickHouse reads domain events, which carry meaning; row changes do not ([RFC-017](@RFC-017)).

| Status | Implemented |
| -- | -- |
| Date | 2025-05-10 |
| Authors | DemoIvan |
| Reviewers | DemoCarol, DemoGrace |

## Context

Product analytics (page views, searches, add-to-cart, checkout steps) are stored in a PostgreSQL database that has grown to 2.4 TB. A funnel query over 30 days takes 4 to 11 minutes, dashboards time out during sales, and the database is the second most expensive in the company. The data is append-only and read in large scans.

## Decision

Analytics events go to **ClickHouse**, fed from Kafka by `events-pipeline` ([RFC-020](@RFC-020)).

* One wide table per event family, ordered by `(event_date, event_type, session_id)`; layout in [SPEC-025](@SPEC-025).
* Event schema per [SPEC-020](@SPEC-020); raw events kept 13 months ([ADR-027](@ADR-027)).
* Pre-aggregated materialised views for the dashboards used daily.
* Transactional data stays in PostgreSQL ([ADR-004](@ADR-004)).

```sql
CREATE TABLE events.page_views
(
    event_date  Date,
    event_time  DateTime64(3, 'UTC'),
    event_type  LowCardinality(String),
    session_id  UUID,
    page        LowCardinality(String),
    country     LowCardinality(FixedString(2)),
    duration_ms UInt32 CODEC(T64, ZSTD(1))
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_date, event_type, session_id);
```

## Options considered

| Option | 30-day funnel query | Storage for 13 months | Monthly cost | Verdict |
| -- | -- | -- | -- | -- |
| **ClickHouse (managed)** | **1.8 s** | **310 GB** | **2,100 USD** | **Chosen** |
| Cloud data warehouse | 6 s | 420 GB | 3,400 USD at our query volume | Cost grows with every dashboard |
| PostgreSQL with partitioning | 140 s | 2.4 TB | 2,600 USD | Still too slow |

Storage numbers assume the codecs measured in [RN-017](@RN-017).

## Consequences

* Dashboards answer in seconds, also during sales.
* ClickHouse is a new engine for the data team; the managed service handles operations.
* The old analytics database is retired after a three-month overlap.

## Follow-up

- [X] Load 13 months of history
- [X] Move the twelve daily dashboards
- [X] Retire the PostgreSQL analytics database

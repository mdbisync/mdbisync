| Status | Implemented |
| -- | -- |
| Date | 2026-04-27 |
| Authors | DemoCarol |
| Reviewers | DemoIvan, DemoMike |
| Plan | [RFC-019 Monthly partitions for the orders table](@RFC-019) |
| Evidence | [RN-016 Partitioning the orders table in PostgreSQL](@RN-016) |

## Context

`orders` in `orders-svc`'s database holds 182 million rows and 410 GB with indexes, growing by about 9 million rows a month. Autovacuum on the table runs for hours, the order history page reads an index of 38 GB, and deleting orders past their retention period ([SPEC-027](@SPEC-027)) would mean deleting rows one batch at a time for weeks. 94 % of reads touch orders from the last 90 days.

## Decision

`orders` and `order_lines` are **range-partitioned by month** on `placed_at`, using PostgreSQL's declarative partitioning.

* Partitions are created three months ahead by a scheduled job; a missing future partition is an alert.
* The primary key becomes `(id, placed_at)`; lookups by id alone go through a small `order_index` table that maps id to month.
* Expired months are detached and dropped, which takes seconds.
* Schema in [SPEC-023](@SPEC-023).

```sql
CREATE TABLE orders (
    id         uuid        NOT NULL,
    placed_at  timestamptz NOT NULL,
    buyer_ref  uuid        NOT NULL,
    status     text        NOT NULL,
    total      bigint      NOT NULL,
    currency   char(3)     NOT NULL,
    PRIMARY KEY (id, placed_at)
) PARTITION BY RANGE (placed_at);

CREATE TABLE orders_2026_05 PARTITION OF orders
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
```

## Options considered

| Option | Order history p95 ([RN-016](@RN-016)) | Retention delete | Vacuum per run | Verdict |
| -- | -- | -- | -- | -- |
| **Monthly partitions** | **14 ms** | **drop a partition, seconds** | **one month, minutes** | **Chosen** |
| Weekly partitions | 13 ms | seconds | smaller | 500 partitions after ten years slow planning |
| Archive table for old orders | 19 ms | batch moves | large | Two tables, complex queries |
| One table (today) | 48 ms | weeks of batches | hours | The problem we have |

## Consequences

* Queries without a `placed_at` range scan all partitions; the order API always passes one.
* Old months can move to cheaper storage later.

## Follow-up

- [X] Partitioned tables in staging, migrated copy of production
- [X] Online migration with dual writes over one weekend
- [X] Drop the unpartitioned table

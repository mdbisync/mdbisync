| Status | Implemented |
| -- | -- |
| Created | 2026-03-02 |
| Authors | DemoGrace |
| Reviewers | DemoCarol, DemoMike |
| Target | Q2 2026 |
| Decision | [ADR-037 Partition the orders table by month](@ADR-037) |

## Summary

Turn `orders` and `order_lines` in the orders database into tables partitioned by month of `created_at`, so the recent months stay small and hot, and old months can be detached and archived.

## Motivation

* `orders` holds 61 million rows and grows by 2.3 million a month; `order_lines` holds 188 million.
* 97 % of queries ask for orders from the last 90 days, but every index covers all of them. The main index is 41 GB and no longer fits in memory.
* Autovacuum on `order_lines` takes 6 hours and falls behind during sales.
* Deleting orders past the retention period ([SPEC-027](@SPEC-027)) is a 9-hour `DELETE` that bloats the table.

Measurements are in [RN-016](@RN-016).

## Proposal

### Layout

Declarative range partitioning on `created_at`, one partition per calendar month, created three months ahead by `pg_partman`. The primary key becomes `(id, created_at)`.

```sql
CREATE TABLE orders (
  id          uuid        NOT NULL,
  created_at  timestamptz NOT NULL,
  buyer_id    uuid        NOT NULL,
  status      text        NOT NULL,
  total_minor bigint      NOT NULL,
  currency    char(3)     NOT NULL,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

SELECT partman.create_parent('public.orders', 'created_at', '1 month', p_premake := 3);
```

### Lookups by id

Order ids are UUIDv7, so the id carries its creation time. `orders-svc` derives `created_at` bounds from the id and adds them to every lookup, so the planner prunes to one partition.

### Old months

Partitions older than 25 months are detached, exported to Parquet in object storage, and dropped. That replaces the 9-hour `DELETE` with a metadata change.

```mermaid
flowchart LR
    new[Premade partitions, 3 months] --> hot[Hot partitions, last 3 months]
    hot --> warm[Warm partitions, up to 25 months]
    warm -->|detach and export| cold[(Parquet archive)]
```

## Alternatives

| Option | Index size for 90 days | Retention cost | Why not |
| -- | -- | -- | -- |
| Keep one table, add partial indexes | 6 GB | 9-hour delete | Deletes still bloat the table |
| Partition by hash of id | 41 GB spread over parts | 9-hour delete | No pruning by time |
| **Partition by month** | **4.1 GB** | **seconds** | Chosen |
| Move old orders to ClickHouse only | 4.1 GB | small | Support needs old orders in the service for 25 months |

## Rollout

- [X] Build the partitioned tables next to the old ones in staging and compare query plans
- [X] Copy production data month by month with logical replication
- [X] Switch reads, then writes, in a 40-second window on 2026-04-28
- [X] Drop the old tables
- [X] First detach of an expired month, 2026-06-01

## Open questions

* Should `order_events` follow? It is append-only and 9 GB; not yet worth it.

| Status | Implemented |
| -- | -- |
| Created | 2025-06-10 |
| Authors | DemoGrace |
| Reviewers | DemoCarol, DemoIvan, DemoKen |
| Target | Q4 2025 |
| Decision | [ADR-015 Give each service its own database](@ADR-015) |

## Summary

Move each service's tables out of the shared `demomart` PostgreSQL cluster into a database the service owns, one service at a time, and replace cross-service SQL with API calls and domain events.

## Motivation

In May 2025 the shared cluster held 214 tables used by nine services. Three problems kept growing:

* **Coupled releases.** 31 % of schema migrations in Q1 2025 touched a table another service also read; each needed a coordinated release.
* **Noisy neighbours.** A slow report query from `fulfilment-svc` held the primary at 92 % CPU for 40 minutes on 2025-04-14, and checkout latency doubled.
* **No ownership.** 46 tables had no clear owner; nobody dared to drop unused columns.

## Proposal

Each service gets its own logical database on a shared PostgreSQL 16 cluster first, and its own cluster when its load justifies it. Other services never read its tables: they call its API or consume its events ([ADR-005](@ADR-005)).

@@picture:rfc-016-migration@@

### Steps per service

1. List every query that touches the service's tables from outside, using `pg_stat_statements` over 14 days.
2. Replace each with an API call or an event consumer.
3. Copy the tables with logical replication into the new database; switch writes in a short read-only window (target under 60 seconds).
4. Revoke the old grants, then drop the old tables after 30 days.

```sql
-- Step 3: copy the orders tables into the new database
CREATE PUBLICATION orders_move FOR TABLE orders, order_lines, order_events;
-- on the new database
CREATE SUBSCRIPTION orders_move
  CONNECTION 'host=pg-shared.internal.example.com dbname=demomart user=replicator'
  PUBLICATION orders_move WITH (copy_data = true);
```

### Order of moves

| Service | Tables | Outside readers | Planned |
| -- | -- | -- | -- |
| `notify-svc` | 6 | 0 | July 2025 |
| `catalog-svc` | 28 | 3 | August 2025 |
| `demo-pay` | 19 | 2 | September 2025 |
| `orders-svc` | 34 | 5 | October 2025 |
| `fulfilment-svc` | 22 | 4 | November 2025 |

## Alternatives

| Option | Isolation | Effort | Why not |
| -- | -- | -- | -- |
| Keep the shared database, add row-level grants | low | small | Load and migrations stay coupled |
| One schema per service in the shared database | medium | small | Cross-schema joins stay possible and tempting |
| **One database per service** | **high** | **large** | Chosen |
| One cluster per service from the start | highest | large, costly | 9 clusters cost about 3.4 times as much; not needed for most services |

## Rollout

- [X] Inventory outside readers per table
- [X] Move `notify-svc` and `catalog-svc`
- [X] Move `demo-pay`
- [X] Move `orders-svc`, with monthly partitions later ([RFC-019](@RFC-019))
- [X] Move `fulfilment-svc`
- [X] Drop the old tables and the shared `demomart` database user

## Open questions

* Reporting still needs joins across services. Answer: reports read the analytics copy in ClickHouse ([RFC-020](@RFC-020)), never the services' databases.

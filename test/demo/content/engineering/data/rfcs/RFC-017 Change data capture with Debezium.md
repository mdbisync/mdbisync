| Status | Implemented |
| -- | -- |
| Created | 2025-06-03 |
| Authors | DemoIvan |
| Reviewers | DemoCarol, DemoGrace, DemoKen |
| Target | Q3 2025 |
| Decision | [ADR-036 Feed the search index from change data capture](@ADR-036) |

## Summary

Stream row changes from the catalog database into Kafka with Debezium, and build the search index and the analytics copy from that stream instead of from nightly exports.

## Motivation

The search index is rebuilt every night from a full export of `catalog-svc`'s database. A seller who changes a price at 09:00 sees the old price in search until the next morning, and 14 % of "price differs from search" complaints in May came from that gap. The export also reads 38 million rows each night and holds a long transaction on the primary.

## Proposal

Run Debezium's PostgreSQL connector on Kafka Connect. It reads the write-ahead log through a logical replication slot and publishes one event per row change.

@@picture:rfc-017-pipeline@@

* **Tables:** `products`, `product_variants`, `prices` and `stock_levels`. Other tables stay out of the stream.
* **Topics:** `catalog.cdc.<table>`, keyed by primary key, 24 partitions, 3 days of retention ([topic rules](@SPEC-021)).
* **Format:** Debezium's change event, converted to the [event envelope](@SPEC-016) by a single message transform, so consumers see the same envelope as for domain events.
* **Search consumer:** `search-svc` applies changes to OpenSearch in batches of up to 500 documents or 200 ms, whichever comes first.

The connector configuration:

```json
{
  "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
  "plugin.name": "pgoutput",
  "slot.name": "catalog_cdc",
  "publication.name": "catalog_cdc",
  "table.include.list": "public.products,public.product_variants,public.prices,public.stock_levels",
  "topic.prefix": "catalog.cdc",
  "heartbeat.interval.ms": "10000",
  "snapshot.mode": "initial"
}
```

### Keeping the slot healthy

A replication slot keeps WAL on the primary until the connector confirms it. If the connector stops, the disk fills. We alert when the slot retains more than 20 GB, and drop and recreate it (with a new snapshot) above 60 GB.

## Alternatives

| Option | Freshness | Load on the primary | Effort | Why not |
| -- | -- | -- | -- | -- |
| Nightly export (today) | up to 24 h | one long read each night | none | Stale prices |
| Events from `catalog-svc` through its outbox | seconds | small | change every write path | Easy to miss a write path; bulk SQL updates bypass it |
| Polling `updated_at` every minute | 1 min | constant scans | small | Misses deletes; index scans on hot tables |
| **Debezium** | **seconds** | **reads the WAL only** | **medium** | Chosen |

## Rollout

- [X] Debezium in staging with a copy of the catalog
- [X] Measure replication lag at peak ([RN-020](@RN-020))
- [X] `search-svc` consumes the stream in shadow mode and compares with the nightly index
- [X] Switch search to the stream; keep the nightly job as a weekly consistency check
- [X] Remove the nightly export

## Open questions

* Should `orders-svc` use the same connector for its analytics copy, or keep its outbox? Answered in [RFC-020](@RFC-020): ClickHouse reads domain events, not row changes.

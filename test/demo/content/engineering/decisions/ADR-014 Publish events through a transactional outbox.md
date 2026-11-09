| Status | Implemented |
| -- | -- |
| Date | 2025-06-20 |
| Authors | DemoCarol |
| Reviewers | DemoIvan, DemoDave |
| Evidence | [RN-026 Outbox polling versus log tailing](@RN-026) |

## Context

After [ADR-005](@ADR-005), services publish to Kafka right after committing to their database. If the process dies between the commit and the publish, the event is lost; if Kafka is slow, the request waits. In May, 37 orders were confirmed in the database but never reached `fulfilment-svc`, and someone found them by hand.

## Decision

Services publish events through a **transactional outbox**: the event is written to an `outbox` table in the same transaction as the change, and a relay publishes it to Kafka afterwards.

* Table layout in [SPEC-022](@SPEC-022); envelope in [SPEC-016](@SPEC-016).
* The relay tails the outbox through logical replication rather than polling ([RN-026](@RN-026)); it publishes in batches of up to 500.
* Published rows are deleted after 24 hours.
* Delivery is at least once; consumers deduplicate by event id.

```mermaid
sequenceDiagram
    participant API as orders-svc
    participant DB as PostgreSQL
    participant R as outbox relay
    participant K as Kafka
    API->>DB: BEGIN; update order; insert outbox row; COMMIT
    R->>DB: read new outbox rows (logical replication)
    R->>K: publish batch
    K-->>R: ack
    R->>DB: mark rows published
```

## Options considered

| Option | Lost events | Added request latency | Extra components | Verdict |
| -- | -- | -- | -- | -- |
| **Outbox with a log-tailing relay** | **none** | **0.3 ms (one insert)** | **relay per service** | **Chosen** |
| Outbox with a polling relay | none | 0.3 ms | relay per service | 1 to 2 s delay, constant polling load |
| Publish after commit (today) | 37 in May | 6 to 40 ms | none | The problem we have |
| Two-phase commit | none | 25 ms | coordinator | Not supported by our Kafka service |

## Consequences

* Events are never lost or published for rolled-back changes.
* Every service with events gets an outbox table and a relay; the Go kit includes both.
* Debezium-based change data capture ([RFC-017](@RFC-017)) remains for tables without domain events.

## Follow-up

- [X] Outbox in `orders-svc`
- [X] Outbox in `demo-pay` and `catalog-svc`
- [X] Remove direct publishing from request handlers

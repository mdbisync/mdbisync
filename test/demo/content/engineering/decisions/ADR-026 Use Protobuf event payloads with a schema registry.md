| Status | Implemented |
| -- | -- |
| Date | 2025-11-29 |
| Authors | DemoIvan |
| Reviewers | DemoCarol, DemoDave |
| Plan | [RFC-018 A schema registry for event payloads](@RFC-018) |

## Context

The first events on Kafka ([ADR-005](@ADR-005)) carried JSON payloads without a schema. Consumers broke three times in 2025 when a producer renamed a field, and analytics jobs guessed types. [RN-024](@RN-024) also found JSON order events 2.6 times larger than their Protobuf form. Since July 2025 the registry of [RFC-018](@RFC-018) has run as a trial; this record makes it the rule.

## Decision

Event payloads are **Protobuf**, registered in a **schema registry** before a producer may publish them.

* Each event type has one message, registered under `<topic>-value`; the envelope's `schema_id` names it ([SPEC-016](@SPEC-016)).
* Compatibility mode is `BACKWARD_TRANSITIVE`: new schemas must read all old events.
* Breaking changes need a new event type with a new major version, for example `orders.order.confirmed.v2`, published side by side for at least 30 days.
* CI checks every change to `proto/events/` against the registry.

```proto
syntax = "proto3";
package demomart.events.orders.v1;

message OrderConfirmed {
  string order_id = 1;
  string buyer_ref = 2;
  repeated Line lines = 3;
  demomart.common.Money total = 4;
  google.protobuf.Timestamp confirmed_at = 5;
}
```

## Options considered

| Option | Payload size (order event) | Compatibility check | Tooling in Go, Kotlin, TypeScript | Verdict |
| -- | -- | -- | -- | -- |
| **Protobuf with a registry** | **460 B** | **registry and CI** | **good** | **Chosen** |
| Avro with a registry | 430 B | registry and CI | weaker in Go and TypeScript | We already use Protobuf for gRPC ([ADR-006](@ADR-006)) |
| JSON Schema | 1,210 B | possible | good | Larger, slower to parse |
| Plain JSON (until now) | 1,210 B | none | trivial | Three breakages in 2025 |

## Consequences

* Producers cannot break consumers without the registry noticing.
* Payloads shrink by about 60 %, which also cuts storage in ClickHouse.
* Reading raw topics needs the registry; a small CLI decodes messages for debugging.

## Follow-up

- [X] Registry in production with backups
- [X] All order and payment events in Protobuf
- [X] Product events in Protobuf

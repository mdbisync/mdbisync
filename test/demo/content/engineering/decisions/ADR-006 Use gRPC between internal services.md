| Status | Accepted |
| -- | -- |
| Date | 2025-03-04 |
| Authors | DemoDave |
| Reviewers | DemoBob, DemoHeidi |

## Context

Services call each other over JSON on HTTP with hand-written clients. The contracts are informal: when `catalog-svc` renamed `price` to `unit_price` in January, `cart-svc` broke in production for 40 minutes. Each team writes its own retry and timeout code, with timeouts from 2 to 30 seconds.

## Decision

Synchronous calls between internal services use **gRPC** with Protobuf contracts.

* Contracts live in the monorepo's `proto/` folder ([ADR-030](@ADR-030)); `buf breaking` rejects incompatible changes in CI.
* Clients are generated; every call has a deadline, by default 800 ms, and retries only idempotent methods, at most twice with jitter.
* Calls carry trace context ([SPEC-005](@SPEC-005)).
* Asynchronous communication stays on Kafka ([ADR-005](@ADR-005)); gRPC is for calls that need an answer now.
* The public API stays REST ([ADR-007](@ADR-007)).

```protobuf
service CatalogService {
  rpc GetProduct(GetProductRequest) returns (Product);
  rpc BatchGetPrices(BatchGetPricesRequest) returns (BatchGetPricesResponse);
}

message BatchGetPricesRequest {
  repeated string product_ids = 1; // at most 200
  string currency = 2;
}
```

## Options considered

| Option | Contract checked | p50 overhead per call | Payload for 50 prices | Verdict |
| -- | -- | -- | -- | -- |
| **gRPC with Protobuf** | **at build time** | **0.4 ms** | **1.9 KB** | **Chosen** |
| JSON over HTTP with OpenAPI | with extra tooling | 1.1 ms | 6.8 KB | Weaker generation for Go |
| GraphQL federation | at runtime | 2.6 ms | 5.2 KB | Too much machinery for service calls |
| Hand-written JSON (today) | no | 1.1 ms | 6.8 KB | The problem we have |

## Consequences

* Breaking changes are caught before merge instead of in production.
* Debugging needs gRPC tools; `grpcurl` is in the service template.
* The service mesh ([RFC-005](@RFC-005)) balances gRPC per request instead of per connection.

## Follow-up

- [X] `buf` lint and breaking checks in CI
- [X] Move `cart-svc` to `catalog-svc` calls to gRPC
- [ ] Move the remaining 23 internal JSON endpoints

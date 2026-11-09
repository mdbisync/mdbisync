| Status | Implemented |
| -- | -- |
| Created | 2025-06-10 |
| Authors | DemoErin |
| Reviewers | DemoFrank, DemoJudy, DemoCarol |
| Target | Q4 2025 |
| Decision | [ADR-016 Version the public API in the URL path](@ADR-016) |

## Summary

Design a second version of the DemoMart public API from its OpenAPI document first: one naming scheme, one error format, one pagination style and one authentication model for every endpoint. Serve it next to v1 under `/v2/`, and retire v1 on the schedule of [ADR-044](@ADR-044).

## Motivation

Version 1 grew out of internal endpoints that were opened to partners one at a time since 2021. In May 2025 it had:

* 74 endpoints with **9 different error formats** and **3 pagination styles** (offset, page number and a timestamp cursor on two endpoints).
* Field names in both `camelCase` and `snake_case`, sometimes in one response.
* Prices as decimal strings on products and as floats on orders.
* 31 % of partner support tickets about inconsistencies rather than bugs.

A new integration took a median of **11 days** from the first API key to the first successful order. Listing past page 200 timed out on large catalogs ([RN-031](@RN-031)).

## Proposal

### Resources and paths

| Resource | Path | Owning service |
| -- | -- | -- |
| Products and variants | `/v2/products` | `catalog-svc` |
| Inventory levels | `/v2/inventory` | `catalog-svc` |
| Orders and shipments | `/v2/orders` | `orders-svc` |
| Refunds | `/v2/refunds` | `demo-pay` |
| Webhook subscriptions | `/v2/webhook-subscriptions` | `notify-svc` |
| Bulk import jobs | `/v2/import-jobs` | `catalog-svc` |

### Conventions

* Field names in `snake_case`; timestamps in RFC 3339 UTC; ids are opaque strings with a type prefix (`prd_`, `ord_`).
* Money as an integer amount in minor units plus an ISO 4217 code ([ADR-020](@ADR-020)).
* Lists use cursor pagination ([RFC-032](@RFC-032)), errors use problem details ([RFC-039](@RFC-039)), mutating calls take idempotency keys ([RFC-034](@RFC-034)).
* Access by OAuth 2.0 client credentials with scopes ([RFC-040](@RFC-040)).

The OpenAPI document is the source of truth; the gateway validates requests against it.

```yaml
openapi: 3.1.0
info:
  title: DemoMart Public API
  version: 2.0.0
servers:
  - url: https://api.example.com/v2
paths:
  /orders/{order_id}:
    get:
      operationId: getOrder
      security:
        - oauth2: [orders:read]
      responses:
        "200":
          description: The order
        "404":
          $ref: "#/components/responses/NotFound"
```

### Routing

@@picture:rfc-030-routing@@

`api-gateway` routes `/v1/` to the existing adapters and `/v2/` straight to the services' public handlers. Both versions share authentication and rate limiting.

## Alternatives

| Option | Effort | Effect on partners | Why not |
| -- | -- | -- | -- |
| Fix v1 in place | small per change | every fix breaks someone | Each change is a breaking change |
| GraphQL for partners | large | new client tooling | Partners asked for REST and webhooks; GraphQL stays in Seller Hub ([ADR-043](@ADR-043)) |
| Version by header | medium | invisible in logs and links | Rejected in [ADR-016](@ADR-016) |
| **v2 under a new path** | **large** | **opt-in migration** | Chosen |

## Rollout

- [X] OpenAPI document for v2 reviewed by three partners
- [X] Orders and products endpoints in the sandbox ([RFC-036](@RFC-036))
- [X] General availability of v2, 2025-11-18
- [X] Generated SDKs for v2 ([RFC-035](@RFC-035))
- [X] v1 deprecation announced with a retirement date ([RFC-037](@RFC-037))
- [X] v1 retired, 2026-06-30 ([RN-038](@RN-038))

## Open questions

* Should v2 support field selection? Deferred: response sizes are already small with compression ([RN-039](@RN-039)).

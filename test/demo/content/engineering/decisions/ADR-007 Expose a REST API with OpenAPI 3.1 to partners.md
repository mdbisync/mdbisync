| Status | Implemented |
| -- | -- |
| Date | 2025-03-17 |
| Authors | DemoHeidi |
| Reviewers | DemoDave, DemoJudy |

## Context

About 300 partners (seller tools, shipping integrators, marketplace aggregators) use DemoMart's public API. It grew endpoint by endpoint, its documentation is a hand-written page, and four endpoints return errors in different shapes. Partners ask for SDKs in TypeScript, Python and Go, and for a description they can generate clients from.

## Decision

The public API is **REST over HTTPS with JSON**, described by one **OpenAPI 3.1** document that is the source of truth.

* The document lives in the monorepo; documentation, SDKs ([RFC-035](@RFC-035)) and the changelog ([RFC-041](@RFC-041)) are generated from it.
* Errors use problem details ([RFC-039](@RFC-039), [SPEC-032](@SPEC-032)).
* A contract test checks every response in staging against the document.
* Internal services do not use the public API; it is served by `api-gateway`, which calls services over gRPC ([ADR-006](@ADR-006)).

```yaml
openapi: 3.1.0
info:
  title: DemoMart API
  version: 2.0.0
servers:
  - url: https://api.example.com/v2
paths:
  /products/{product_id}:
    get:
      operationId: getProduct
      responses:
        "200":
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Product" }
```

## Options considered

| Option | Partner familiarity (survey, n = 84) | Client generation | Caching | Verdict |
| -- | -- | -- | -- | -- |
| **REST with OpenAPI 3.1** | **92 %** | **mature in all three languages** | **HTTP caching** | **Chosen** |
| GraphQL | 41 % | good | needs persisted queries | Few partners want it |
| gRPC with a JSON gateway | 18 % | good | weak | Unfamiliar to partners |

## Consequences

* The OpenAPI document must be updated with every change; CI fails when the implementation and the document disagree.
* SDKs and documentation stop drifting from the API.
* Versioning follows [ADR-016](@ADR-016).

## Follow-up

- [X] Write the OpenAPI document for all 64 existing operations
- [X] Contract tests in staging
- [X] Publish generated reference documentation ([SPEC-030](@SPEC-030))

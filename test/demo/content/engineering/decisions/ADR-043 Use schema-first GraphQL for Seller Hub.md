| Status | Accepted |
| -- | -- |
| Date | 2026-07-17 |
| Authors | DemoPeggy |
| Reviewers | DemoLaura, DemoHeidi |

## Context

Seller Hub, the sellers' web console, calls 37 REST endpoints of the public API and 12 internal ones. Its listing page makes 9 requests on load, over-fetches about 70 % of the bytes it receives, and changes to the console often need new endpoints in the public API that partners then see too. Partners and the console have different needs.

## Decision

Seller Hub's frontend talks to a **GraphQL API built schema-first**, served by a new `sellerhub-bff` service. The public API stays REST ([ADR-007](@ADR-007)).

* The schema is written in SDL in the monorepo; resolvers in Go are generated with gqlgen.
* `sellerhub-bff` calls services over gRPC; it holds no data of its own.
* Persisted queries only: the console sends a query hash, so arbitrary queries are rejected in production.
* Query cost limit: 5,000 points per request, computed from list sizes.

```graphql
type Listing {
  id: ID!
  title: String!
  price: Money!
  stock: Int!
  qualityScore: Int
  variants(first: Int = 20, after: String): VariantConnection!
}

type Query {
  listings(first: Int = 50, after: String, filter: ListingFilter): ListingConnection!
}
```

## Options considered

| Option | Requests on listing page load | Bytes over-fetched | Public API changes for console needs | Verdict |
| -- | -- | -- | -- | -- |
| **Schema-first GraphQL BFF** | **1** | **under 10 %** | **none** | **Chosen** |
| Code-first GraphQL | 1 | under 10 % | none | Schema reviews are harder when it is generated |
| REST backend-for-frontend | 2 to 3 | about 20 % | none | An endpoint per screen |
| Public API (today) | 9 | about 70 % | frequent | The problem we have |

## Consequences

* The console's data needs no longer leak into the public API.
* A new service to run; it is stateless and scales with Seller Hub traffic.
* Page load times are tracked in [RN-077](@RN-077).

## Follow-up

- [X] `sellerhub-bff` with listings and orders
- [ ] Inventory and payouts screens on GraphQL
- [ ] Remove the 12 internal REST endpoints used only by Seller Hub

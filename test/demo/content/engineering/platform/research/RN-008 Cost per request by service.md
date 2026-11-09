| Status | Complete |
| -- | -- |
| Date | 2025-12-09 |
| Authors | DemoNina |
| Follows | [RFC-006 Cost allocation labels for every workload](@RFC-006) |

## Question

With the cloud bill split by service ([RFC-006](@RFC-006)), what does one request cost in each service, and where would savings matter most?

## Method

* November 2025 bill: 196,000 USD, 96 % assigned to a team and service.
* Costs per service: its own resources plus its share of shared costs ([SPEC-014](@SPEC-014)).
* Requests per service from `http_server_requests_total` and gRPC counters.
* Six services with the largest bills shown.

## Results

@@picture:rn-008-cost@@

@@table:rn-008-cost@@

@@csv:rn-008-cost@@

| Service | Requests in November | Cost in November | Largest item |
| -- | -- | -- | -- |
| `checkout-svc` | 1.9 billion | 21,700 USD | database (writes and replicas) |
| `search-svc` | 4.1 billion | 19,700 USD | OpenSearch nodes |
| `reco-svc` | 1.6 billion | 11,700 USD | compute for embeddings |
| `cart-svc` | 3.4 billion | 7,100 USD | Redis |
| `catalog-svc` | 5.2 billion | 8,300 USD | database replicas |
| `api-gateway` | 12.8 billion | 11,500 USD | load balancers |

## Findings

* Checkout is expensive per request but cheap per order: about 0.004 USD per order placed.
* Search is the largest bill after checkout, driven by OpenSearch nodes sized for peak sales all year.
* Edge caching ([ADR-035](@ADR-035)) already keeps 70 % of product page reads away from `catalog-svc`; without it the catalogue bill would roughly triple.

## Recommendation

Look first at OpenSearch sizing for search (scheduled scaling outside sales) and at embedding batch sizes for `reco-svc`. Publish this table every month on the platform team's page.

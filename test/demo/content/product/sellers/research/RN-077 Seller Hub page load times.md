| Status | Complete |
| -- | -- |
| Date | 2026-05-26 |
| Authors | DemoKen, DemoGrace |
| Led to | [ADR-043 Use schema-first GraphQL for Seller Hub](@ADR-043) |

## Question

Why are Seller Hub's busiest pages slow for large sellers, and would a GraphQL layer that fetches exactly what a page shows make them fast enough?

## Method

* Real user measurements from Seller Hub for April 2026: time from navigation to the page's main table being usable, at the 75th percentile, for sellers with more than 1,000 listings.
* Requests per page load counted from the browser's resource timing.
* A GraphQL prototype for the five busiest pages, served from the same region and backed by the same services, measured with the same sellers' data replayed in staging (40 sellers, 20 loads per page each).
* Payload size: bytes transferred for the page's data, compressed.

## Results

@@picture:rn-077-load-time@@

@@table:rn-077-load-time@@

@@csv:rn-077-load-time@@

@@picture:rn-077-requests@@

@@table:rn-077-requests@@

## Findings

* The listings page is slowest at 4.1 s, then orders at 3.4 s. Both are above our 2.5 s target for Seller Hub ([SPEC-008](@SPEC-008)).
* The cause is the number of round trips, not the services: the listings page makes 19 REST calls, several of them one per row (stock, quality, price history), and waits on the slowest chain.
* REST responses carry far more than the page shows. The orders page downloads 410 KB of data to display 50 rows; the prototype downloads 62 KB.
* The GraphQL prototype brings every page under 2 s at the 75th percentile, with one request per page and batched loading behind it.
* Server-side cost per page load stayed within 5 % of the REST version, because the gateway batches calls to the same service.

## Recommendation

Put a schema-first GraphQL gateway in front of Seller Hub's services, with per-request batching, and move the five busiest pages first. Decided in [ADR-043](@ADR-043). The public API for partners stays REST ([ADR-007](@ADR-007)).

| Status | Complete |
| -- | -- |
| Date | 2026-01-27 |
| Authors | DemoNina, DemoKen |
| Led to | [RFC-033 Rate limits per partner and endpoint](@RFC-033), [RFC-038 Bulk endpoints for catalog updates](@RFC-038) |

## Question

What do partners spend their API calls on, and who makes the writes? We need the answer to size rate limits per endpoint class ([RFC-033](@RFC-033)) and to decide how to serve partners that push whole catalogs.

## Method

* Source: `api-gateway` access logs, 2026-01-05 to 2026-01-18, both v1 and v2, 412 million calls from 734 partners.
* Endpoints grouped by resource and method; health checks and token requests left out.
* Partners ranked by their number of write calls (`POST`, `PATCH`, `DELETE`).
* For comparison, the same grouping on the logs of June 2025, the first cut of this note, made before webhooks moved to `notify-svc` ([RFC-031](@RFC-031)).

## Results

@@picture:rn-029-calls-by-endpoint@@

@@table:rn-029-calls-by-endpoint@@

@@picture:rn-029-writes-by-partner@@

@@table:rn-029-writes-by-partner@@

Calls per endpoint group:

@@csv:rn-029-calls-by-endpoint@@

## Findings

* **Reads dominate.** Product, order and inventory reads are 65.3 % of all calls. Product reads alone are 31.4 %, mostly nightly catalog scans.
* **Polling for orders has dropped.** In June 2025, `GET /v1/orders` every minute made up 38 % of all calls. With signed webhooks and retries, order reads are down to 22.7 %, and most of the rest come from partners still on v1.
* **Writes are concentrated.** Four partners make 52 % of all write calls, nearly all of them price and stock updates for catalogs of 40,000 to 120,000 products. They send one `PATCH` per variant.
* **Order actions are few but urgent.** Confirmations, shipments and refunds are only 4.8 % of calls, yet 61 % of the `429` responses in the period hit them, because a single per-partner limit is shared with catalog traffic.

> [!IMPORTANT]
> The shared limit makes catalog scans block order confirmations. Order actions need a budget of their own.

## Recommendation

* Split limits into endpoint classes, with order actions separate from reads and writes ([RFC-033](@RFC-033)).
* Give the four large catalog partners a way to send changes in bulk. A synchronous batch endpoint was proposed in [RFC-038](@RFC-038) and lost to import jobs ([SPEC-041](@SPEC-041)).
* Repeat this note after v1 is retired ([ADR-044](@ADR-044)).

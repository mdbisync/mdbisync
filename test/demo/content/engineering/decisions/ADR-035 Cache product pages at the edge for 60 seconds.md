| Status | Superseded |
| -- | -- |
| Date | 2026-03-31 |
| Authors | DemoLaura |
| Reviewers | DemoBob, DemoGrace |
| Superseded by | [ADR-041 Serve images from a CDN with on-the-fly resizing](@ADR-041) |

> [!NOTE]
> Superseded in June 2026 by ADR-041, which moved product pages and images to one CDN and replaced the fixed 60-second lifetime with purges triggered by product events.

## Context

Server rendering ([ADR-023](@ADR-023)) moved work to the web shop's servers. During a sale in March, product pages took 3,400 requests per second at peak and the web shop needed 64 pods. 82 % of those requests were for the same 5,000 products, rendered again for every visitor. Prices and stock change often, so a long cache lifetime would show stale prices.

## Decision

Product pages are cached at the edge for **60 seconds**, with `stale-while-revalidate` for another 30.

* `Cache-Control: public, s-maxage=60, stale-while-revalidate=30` on anonymous product pages; signed-in pages are not cached.
* Personal parts (cart count, sign-in state) load from the client after the page.
* Stock shown on cached pages says "in stock" or "few left", never an exact count; checkout checks stock exactly ([SPEC-054](@SPEC-054)).

```http
HTTP/1.1 200 OK
Cache-Control: public, s-maxage=60, stale-while-revalidate=30
Vary: Accept-Language
```

## Options considered

| Option | Origin requests at peak | Price staleness | Effort | Verdict |
| -- | -- | -- | -- | -- |
| **60 s edge cache** | **about 400 per second** | **up to 90 s** | **small** | **Chosen** |
| Edge cache purged on product events | about 150 per second | seconds | medium | Better; needs purge plumbing first |
| No cache (today) | 3,400 per second | none | none | The problem we have |

## Consequences

* The web shop needs a fifth of the pods at peak.
* A price change can show the old price for up to 90 seconds; checkout always uses the current price.

## Follow-up

- [X] Cache headers on product pages
- [X] Client-side personal parts
- [X] Plan event-driven purges (done in [ADR-041](@ADR-041))

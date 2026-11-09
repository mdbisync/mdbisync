| Status | Complete |
| -- | -- |
| Date | 2026-02-03 |
| Authors | DemoNina |
| Led to | [ADR-034 Use a token bucket for API rate limits](@ADR-034) |

## Question

Which rate limit algorithm should `api-gateway` use per partner and endpoint class: one that stops bursts, costs little memory in Redis and adds little latency?

## Method

* Four algorithms implemented as Redis Lua scripts: fixed window (today), sliding log, sliding window counter and token bucket.
* Replayed one day of real traffic (2026-01-14, 29.6 million calls from 734 partners) against each, at a limit of 20 requests per second per partner and class.
* Measured the largest number of requests let through in any one-second window, relative to the limit; the memory per partner and class; and the latency added at the gateway.

## Results

@@picture:rn-032-burst@@

@@table:rn-032-burst@@

@@picture:rn-032-memory@@

@@table:rn-032-memory@@

Added latency at the gateway, p99:

| Algorithm | Redis calls per request | Added p99 latency |
| -- | -- | -- |
| Fixed window | 1 | 1.9 ms |
| Sliding window counter | 1 | 2.2 ms |
| Sliding log | 1, plus trimming | 4.7 ms |
| Token bucket | 1 | 2.1 ms |

## Findings

* **The fixed window lets double the limit through** at the boundary between two windows: a client that sends its whole budget at the end of one second and again at the start of the next gets 40 requests through in one second.
* **The sliding log is exact but expensive:** at 20 requests per second it keeps up to 200 timestamps per key, 3,200 bytes, and trimming them doubles its latency.
* **The sliding window counter and the token bucket are close.** Both need about 32 bytes and one Redis call. The counter lets about 10 % more through at window edges.
* **Only the token bucket allows a deliberate burst.** Partners that start their nightly job with a quick volley of reads are served at once, up to the bucket size, without raising the steady rate.

## Recommendation

Use a token bucket per partner and endpoint class, sized with a rate and a burst ([ADR-034](@ADR-034), [RFC-033](@RFC-033)). Keep the counter as the fallback if Redis memory ever becomes a constraint.

| Status | Complete |
| -- | -- |
| Date | 2025-09-16 |
| Authors | DemoKen, DemoErin |
| Led to | Keeping all checks in `api-gateway` for v2 ([RFC-030](@RFC-030)) |

## Question

The v2 gateway checks tokens, rate limits, idempotency keys and request bodies before a request reaches a service. How much latency do these checks add, and is any of them worth moving or caching?

## Method

* OpenTelemetry spans for each gateway stage ([ADR-010](@ADR-010)), sampled at 10 % for one week of v2 beta traffic, 2025-09-01 to 2025-09-07, 38 million requests.
* Stages: TLS termination, token check, rate limit (Redis), idempotency lookup (Redis, mutating calls only), validation against the OpenAPI document, routing to the service.
* Percentiles computed per stage; total gateway time compared with the service's own time.

## Results

@@picture:rn-036-stages@@

@@table:rn-036-stages@@

@@csv:rn-036-stages@@

| Measure | p50 | p99 |
| -- | -- | -- |
| All gateway stages together | 2.9 ms | 11.7 ms |
| Service time behind the gateway | 24 ms | 186 ms |
| Gateway share of the total | 11 % | 6 % |

## Findings

* **The gateway adds 2.9 ms at p50 and 11.7 ms at p99.** That is 6 % of p99 response time; the services dominate.
* **TLS is the largest single stage** at 3.8 ms p99, mostly full handshakes from clients that do not reuse connections. Partners on the SDKs reuse connections and see 1.1 ms.
* **The two Redis checks together add 4.5 ms at p99.** Running them as one pipelined call for mutating requests saves about 1.4 ms.
* **Token checks are cheap**, 0.6 ms at p99, because JWT keys are cached and verification is local ([SPEC-031](@SPEC-031)).
* **Validation costs 1.9 ms at p99** on large product bodies; it catches 38 % of client errors before they reach a service ([RN-033](@RN-033)), which is worth it.

## Recommendation

* Keep authentication, limits, idempotency and validation in the gateway for v2 rather than repeating them in each service.
* Pipeline the rate limit and idempotency calls to Redis.
* Encourage connection reuse: the SDKs keep connections alive by default ([SPEC-044](@SPEC-044)).

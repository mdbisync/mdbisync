| Status | Complete |
| -- | -- |
| Date | 2025-12-16 |
| Authors | DemoKen |
| Led to | [RFC-003 Autoscaling services on request rate](@RFC-003) |

## Question

Would `checkout-svc` have kept its latency during the November 2025 sale if it had scaled on requests per pod instead of CPU?

## Method

* Recorded request rates of the first 15 minutes of the sale, when traffic grew to 2.4 times normal within 4 minutes.
* Replayed against a staging copy sized like production, with the same database and payment mock.
* Two runs: the production autoscaler (70 % CPU), and KEDA on 180 requests per second per pod.
* p99 latency per minute; time until the first new pod was ready.

## Results

@@picture:rn-005-replay@@

@@table:rn-005-replay@@

@@csv:rn-005-replay@@

| Measure | Scale on CPU | Scale on request rate |
| -- | -- | -- |
| First new pod ready | 4.5 min | 1.5 min |
| Highest p99 | 1,320 ms | 390 ms |
| Minutes with p99 above 1 s | 5 | 0 |
| Pods at the end | 22 | 24 |

## Findings

* `checkout-svc` spends most of its time waiting on `demo-pay` and PostgreSQL, so CPU lags traffic by about 3 minutes.
* On request rate, the first new pod was ready after 1.5 minutes, and p99 never passed 390 ms.
* The request-rate setup ended with two more pods, a cost of about 3 % for this service during peaks.

## Recommendation

Scale customer-facing, I/O-bound services on requests per pod, with targets from load tests ([ADR-046](@ADR-046)). Keep CPU as a second trigger for compute-heavy services.

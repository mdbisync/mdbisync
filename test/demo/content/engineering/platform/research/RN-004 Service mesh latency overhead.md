| Status | Complete |
| -- | -- |
| Date | 2025-07-08 |
| Authors | DemoFrank, DemoKen |
| Led to | [RFC-005 A service mesh for mutual TLS](@RFC-005), rejected |

## Question

How much latency and memory would a sidecar service mesh add to the checkout path, compared with encrypting traffic in the gRPC clients themselves?

## Method

* A staging copy of the checkout path: `checkout-svc`, `cart-svc`, `demo-pay` (with the payment provider mocked), `orders-svc`, `identity-svc`.
* One checkout makes 7 internal calls in sequence.
* Three setups: no encryption (today), sidecar mesh with mutual TLS, and mutual TLS in the gRPC clients with platform-issued certificates.
* 300 checkouts per second for 30 minutes per setup, three runs each; median run reported.

## Results

@@picture:rn-004-latency@@

@@table:rn-004-latency@@

@@csv:rn-004-latency@@

| Measure | Sidecar mesh | Client TLS |
| -- | -- | -- |
| Added latency per hop, p50 | 1.8 ms | 0.1 ms |
| Added latency per hop, p99 | 6.4 ms | 0.2 ms |
| Added memory per pod | about 60 MiB | about 4 MiB |
| Added memory, whole cluster | 14 % | 1 % |
| CPU per 1,000 requests | +11 % | +2 % |

## Findings

* The mesh added 31 ms to checkout p99 (from 512 to 543 ms), because the per-hop overhead adds up over seven sequential calls.
* Client TLS was within measurement noise on latency.
* The mesh gives features we do not use yet (traffic shifting, retries in the proxy); canaries already shift traffic ([RFC-001](@RFC-001)).

## Recommendation

Do not adopt the sidecar mesh. Encrypt with mutual TLS in the gRPC clients through the service template, and revisit node-level meshes in 2026.

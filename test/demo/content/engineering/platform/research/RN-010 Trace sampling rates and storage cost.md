| Status | Complete |
| -- | -- |
| Date | 2025-12-02 |
| Authors | DemoGrace, DemoKen |
| Led to | [SPEC-005 Trace context propagation](@SPEC-005), version 1.1 |

## Question

Which trace sampling setup keeps the traces we need for debugging at a cost we accept?

## Method

* One week of traces at 100 % sampling in staging under replayed production traffic, then projected to production volume.
* Storage cost at our tracing backend's prices, 14 days of retention.
* "Traces we need": every trace with an error or a duration over 2 seconds, plus every checkout. We counted how many of those each setup keeps.

## Results

@@picture:rn-010-cost@@

@@table:rn-010-cost@@

| Setup | Monthly cost | Error and slow traces kept | Checkout traces kept |
| -- | -- | -- | -- |
| 100 % of everything | 46,000 USD | 100 % | 100 % |
| 5 % head sampling only | 2,400 USD | 5 % | 5 % |
| **5 % head sampling, 100 % of errors and slow traces, 100 % of checkout** | **3,300 USD** | **100 %** | **100 %** |

## Findings

* Cost grows almost linearly with the sampling rate.
* Head sampling alone throws away 95 % of the traces engineers actually open.
* Tail sampling in the collector keeps all error and slow traces for 900 USD a month more than plain 5 % sampling. It needs the collector to hold each trace for 30 seconds before deciding, which costs 3 extra collector pods.

## Recommendation

Sample 5 % at the edge, keep all checkout traces, and tail-sample every error and every trace over 2 seconds. Written into [SPEC-005](@SPEC-005).

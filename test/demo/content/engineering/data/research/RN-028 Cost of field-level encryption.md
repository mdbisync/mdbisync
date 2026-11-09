| Status | Complete |
| -- | -- |
| Date | 2025-12-15 |
| Authors | DemoPeggy, DemoMike |
| Led to | [ADR-028 Encrypt personal data at the field level](@ADR-028) |

## Question

What does encrypting personal data fields in the application ([RFC-029](@RFC-029)) cost in request latency and CPU, with and without a cache of data keys?

## Method

* A build of `orders-svc` with the encryption library, in staging, against a copy of the orders database where delivery names and addresses were sealed with AES-256-GCM.
* Three operations: read one order, list a buyer's last 20 orders, create an order.
* Three setups: clear text (today), encrypted with the data key cached in the pod, and encrypted with a cache miss, which unwraps the data key through the key management service first.
* 50,000 requests per operation and setup at production rates; we report p99 latency.
* Cache hit rate measured separately over a replayed hour of production traffic with a 5-minute cache.

## Results

@@picture:rn-028-latency@@

@@table:rn-028-latency@@

@@csv:rn-028-latency@@

## Findings

* With a cached key, encryption adds 0.3 to 1.4 ms at p99: reading one order goes from 3.1 to 3.4 ms, a list of 20 from 9.8 to 11.2 ms.
* A cache miss adds about 18 ms, the p99 of one unwrap call to the key management service.
* With a 5-minute cache, 97.2 % of requests found their key cached. Buyers usually make several requests within minutes.
* CPU per request rose by 4 %; AES-GCM uses the processor's hardware instructions.
* At peak, unwrap calls reached 310 per second, under the limit of 1,000 we set ([SPEC-029](@SPEC-029)).

## Recommendation

Encrypt at the field level with a 5-minute data key cache per pod. The cost is small enough for every read path; no path needs a clear-text copy. Decided in [ADR-028](@ADR-028).

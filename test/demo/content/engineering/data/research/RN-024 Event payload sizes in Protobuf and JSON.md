| Status | Complete |
| -- | -- |
| Date | 2025-10-20 |
| Authors | DemoCarol |
| Led to | [ADR-026 Use Protobuf event payloads with a schema registry](@ADR-026) |

## Question

How much larger would event payloads be in JSON than in Protobuf, before and after Kafka's compression, and does the difference matter for our brokers and consumers?

## Method

* 100,000 real events of each of four types, taken from Kafka with customer data removed: `orders.order.confirmed`, `payments.payment.captured`, `catalog.product.updated` and the analytics event `search_performed`.
* Each encoded as Protobuf (as today) and as JSON with the same field names, without whitespace.
* Average encoded size per event; then batches of 500 compressed with zstd, as the producers do ([SPEC-021](@SPEC-021)).
* Encode and decode time measured in Go on one core.

## Results

@@picture:rn-024-size@@

@@table:rn-024-size@@

@@csv:rn-024-size@@

## Findings

* JSON is 2.6 times larger on average across the four types, from 2.58 times for order events to 2.71 times for search events.
* After zstd compression of 500-event batches, the gap shrinks to 1.4 times: JSON's repeated field names compress well.
* Decoding JSON took 3.2 times longer than Protobuf in Go (4.1 µs against 1.3 µs per order event).
* At peak (9,000 events per second), JSON would add about 11 MB/s before compression on the order topic alone, and about 30 % more broker disk after compression.

## Recommendation

Keep Protobuf for event payloads. Its weak point is that a reader needs the schema; solve that with a schema registry and a schema id in the envelope, as [RFC-018](@RFC-018) proposes, rather than switching to JSON.

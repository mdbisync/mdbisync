| Status | Complete, updated 2026-01-12 |
| -- | -- |
| Date | 2025-07-29 |
| Authors | DemoErin, DemoOscar |
| Led to | [RFC-034 Idempotency keys for mutating requests](@RFC-034) |

## Question

How often do partners send the same mutating request twice, what does it cost, and would idempotency keys stop it?

## Method

* All v1 `POST` and `PATCH` calls in July 2025, 61 million.
* A duplicate is a call from the same partner to the same path with a byte-identical body within 60 seconds of an earlier one that succeeded.
* For refunds, we matched duplicates against payment records to count refunds actually paid twice.
* Update: the same count for v2 in December 2025, after keys became required ([SPEC-035](@SPEC-035)).

## Results

@@picture:rn-037-duplicates@@

@@table:rn-037-duplicates@@

@@picture:rn-037-delay@@

@@table:rn-037-delay@@

@@csv:rn-037-duplicates@@

## Findings

* **Refunds are the worst case:** 0.31 % of refund calls were duplicates, and 41 of them paid a buyer twice in July 2025, 3,870 EUR in total, recovered by hand.
* **Shipments come next** at 0.18 %, sending buyers two "shipped" messages.
* **Duplicates are retries.** 79 % arrived 1 to 30 seconds after the original, matching common client timeouts of 5, 10 and 30 seconds. The original had succeeded; the client had not seen the answer.
* Inventory updates are rarely duplicated (0.05 %) and harmless when they are, because they set an absolute value.
* A natural key per resource would cover refunds but not products or shipments; one header covers all.

## Recommendation

Require an `Idempotency-Key` on every mutating call, stored at the gateway for 24 hours ([RFC-034](@RFC-034), [ADR-019](@ADR-019)).

## Update, January 2026

In December 2025, with keys required on v2, no refund was paid twice. 0.27 % of v2 mutating calls were replays answered from the stored response. The remaining double refunds came from v1, one more reason for its early retirement ([RFC-037](@RFC-037)).

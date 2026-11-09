| Status | Complete, updated 2026-07-06 |
| -- | -- |
| Date | 2025-07-01 |
| Authors | DemoFrank, DemoHeidi |
| Led to | [RFC-031 Webhooks with retries and signatures](@RFC-031) |

## Question

How many webhook deliveries fail for good today, and how long would we have to keep retrying to recover the ones that can be recovered?

## Method

* All webhook attempts logged by the five services that sent webhooks in June 2025: 3.1 million deliveries to 512 partner endpoints.
* A delivery "failed for good" if its last attempt was not `2xx`.
* For each failed delivery we probed the same endpoint every hour afterwards with a signed no-op request and recorded when it first answered `2xx`. That tells us when a retry would have succeeded.
* The update of July 2026 repeats the first measurement on `notify-svc`'s delivery log for Q2 2026.

## Results

@@picture:rn-030-recovery@@

@@table:rn-030-recovery@@

Recovery by hour, for the 71,300 deliveries that failed in June 2025:

@@csv:rn-030-recovery@@

## Findings

* **2.3 % of deliveries failed for good**, about 71,300 in June 2025. Two services did not retry at all; the others gave up within 10 minutes.
* **Most failures are short outages.** 41 % of the endpoints were back within an hour, 94.3 % within a day.
* **72 hours recovers 99.6 %** of the failures that recover at all. Going to 96 hours adds only 0.2 points.
* The rest (0.4 %) are endpoints that were removed or whose certificate expired and was never renewed.
* Weekend outages are the long tail: 63 % of failures still open after 24 hours started on a Friday or Saturday.

## Recommendation

Retry on a schedule that front-loads attempts (1 min, 5 min, 30 min, 2 h) and keeps going every 12 hours up to 72 hours. Deliver from one service with one policy. Both are in [RFC-031](@RFC-031) and specified in [SPEC-039](@SPEC-039).

## Update, July 2026

@@picture:rn-030-failed@@

@@table:rn-030-failed@@

With `notify-svc` and the 72-hour schedule, 0.14 % of deliveries failed for good in Q2 2026, about 4,900 a month out of 3.5 million. Most of those belong to partners whose endpoint was down for longer than 72 hours; replaying them on request is proposed in [RFC-042](@RFC-042).

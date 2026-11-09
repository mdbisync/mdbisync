| Status | Complete |
| -- | -- |
| Date | 2026-10-05 |
| Authors | DemoIvan |
| Led to | Fixes tracked under [RFC-028 A dead letter topic for every consumer](@RFC-028) |

## Question

A year after every consumer got a dead letter topic ([RFC-028](@RFC-028)), how many messages are parked, by whom and why, and which causes are worth fixing?

## Method

* All messages in every `dlq.*` topic from October 2025 to September 2026, read from the 30-day topics each month and counted by the `dlq-consumer-group` and `dlq-reason` headers ([SPEC-028](@SPEC-028)).
* Reasons grouped in two: data problems (`decode_error`, `validation_error`) and dependency problems (`dependency_timeout`, `dependency_error`, `unknown`).
* For the largest groups we sampled 50 messages each and read the errors.

## Results

@@picture:rn-027-volume@@

@@table:rn-027-volume@@

@@csv:rn-027-volume@@

## Findings

* 17,125 messages were parked in twelve months out of about 41 billion consumed: 0.00004 %.
* `events-pipeline` parked 12,400, almost all validation errors: analytics events from app version 6.12, which sent `quantity` as a string ([SPEC-020](@SPEC-020)). The app fixed it in 6.13; 9,800 of the 12,400 came from the 6 weeks before most users updated.
* `search-svc` parked 2,310, mostly dependency timeouts during OpenSearch reindexing; it now pauses consumption while a reindex runs.
* `notify-svc` parked 1,840, mostly timeouts of its template service, the same cause [RN-018](@RN-018) found.
* `demo-pay` and `recon-svc` parked 155 together; each was read by a person and re-driven or resolved.
* No partition stopped for a decode error all year, against three stops in the two months before dead letter topics.

## Recommendation

* Validate analytics events in the app before sending, with the same schema the pipeline uses.
* Give `notify-svc` a cache of rendered templates, so a slow template service does not park messages.
* Keep the alert threshold at 10 parked messages in 10 minutes; it fired 23 times, and every time for a real problem.

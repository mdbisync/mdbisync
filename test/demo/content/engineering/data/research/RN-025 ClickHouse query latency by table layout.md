| Status | Complete |
| -- | -- |
| Date | 2026-01-26 |
| Authors | DemoNina, DemoIvan |
| Led to | [SPEC-025 ClickHouse events table](@SPEC-025), version 2.0 |

## Question

Our dashboards filter by event type first, but `analytics.events` is sorted by date first. How much faster would the common queries be with a sort key that starts with the event type, and what does reading through `FINAL` to remove duplicates cost?

## Method

* Three copies of three months of `analytics.events` (1.8 billion rows) on the production cluster's spare shard:
  * v1, sorted by `(event_date, event_type, session_id)`, today's layout;
  * v2, sorted by `(event_type, event_date, platform, event_id)`;
  * v2 queried through `FINAL`, which merges duplicates at read time.
* Four queries that make up 82 % of dashboard time, each run 20 times with a cold cache; the chart shows the median.

## Results

@@picture:rn-025-latency@@

@@table:rn-025-latency@@

@@csv:rn-025-latency@@

## Findings

* The new sort key cuts the 30-day funnel from 9.8 s to 2.1 s and the daily event count from 3.2 s to 0.6 s: ClickHouse reads only the granules of the requested event types.
* Session lookups improve slightly (0.9 s to 0.7 s) with a bloom filter skip index on `session_id`; neither layout sorts by session.
* `FINAL` makes v2 queries 3 to 5 times slower: the funnel takes 6.4 s, top products 6.5 s. That is the cost [RFC-024](@RFC-024) wanted to avoid with exactly-once delivery.
* Duplicates are 0.02 % of rows. For dashboards that tolerate them until the next merge, plain reads are enough.

## Recommendation

* Change the sort key to `(event_type, event_date, platform, event_id)` and switch the engine to `ReplacingMergeTree` ([SPEC-025](@SPEC-025) version 2.0).
* Dashboards read the table directly; only finance and reconciliation reports read the `events_dedup` view.

| Status | Accepted |
| -- | -- |
| Date | 2025-12-13 |
| Authors | DemoGrace |
| Reviewers | DemoIvan, DemoOscar |
| Plan | [RFC-023 A retention policy for raw events](@RFC-023) |

## Context

Raw analytics events in ClickHouse ([ADR-011](@ADR-011)) are kept forever. They grow by about 26 GB a month after compression ([RN-023](@RN-023)) and contain pseudonymous identifiers for every session. Nobody has queried raw events older than a year, while year-over-year comparisons need slightly more than a year.

## Decision

Raw events are kept for **13 months**, then deleted. Aggregates are kept longer.

* ClickHouse tables drop whole monthly partitions with a TTL; partitions are monthly already ([SPEC-025](@SPEC-025)).
* Daily aggregates (counts, sums, funnels by country and device) are kept for 5 years; they contain no session or user identifiers.
* Kafka topics keep events for 7 days; the events pipeline can replay from ClickHouse for backfills within 13 months ([RFC-027](@RFC-027)).
* All periods are listed in [SPEC-027](@SPEC-027).

```sql
ALTER TABLE events.page_views
    MODIFY TTL event_date + INTERVAL 13 MONTH DELETE;
```

## Options considered

| Option | Storage after 3 years | Year-over-year analysis | Personal data kept | Verdict |
| -- | -- | -- | -- | -- |
| **13 months raw, 5 years aggregates** | **about 360 GB** | **yes, with a month of margin** | **13 months** | **Chosen** |
| 25 months raw | about 680 GB | two years back | 25 months | No query has needed it |
| 90 days raw | about 90 GB | aggregates only | 90 days | Breaks seasonal analysis |
| Forever (today) | about 940 GB | yes | forever | Cost and privacy risk |

## Consequences

* Storage stops growing after 13 months; costs flatten at about 2,300 USD a month.
* Analyses older than 13 months must use aggregates; the data team adds aggregates before they are needed.

## Follow-up

- [X] TTL on all raw event tables
- [X] Five-year aggregate tables
- [ ] Review the aggregate list each quarter

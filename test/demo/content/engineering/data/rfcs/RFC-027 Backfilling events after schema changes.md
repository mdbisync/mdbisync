| Status | In review |
| -- | -- |
| Created | 2026-09-15 |
| Authors | DemoNina |
| Reviewers | DemoCarol, DemoIvan |
| Target | Q4 2026 |
| Decision | open |

## Summary

A standard way to rebuild derived data after an event schema change: replay events from the analytics copy in ClickHouse into a dedicated backfill topic, at a controlled rate, and let consumers rebuild without touching live traffic.

## Motivation

* Kafka keeps domain events for 7 days ([SPEC-021](@SPEC-021)). A consumer that adds a new field to its read model cannot rebuild from Kafka alone.
* In 2026 three teams wrote their own one-off backfill scripts; one replayed 40 million events at full speed into the live topic and delayed order notifications by 25 minutes.
* Events written before the schema registry ([RFC-018](@RFC-018)) have no `schema_id`; each script guessed the schema.

## Proposal

### Source

The analytics copy of domain events in ClickHouse keeps 13 months ([ADR-027](@ADR-027)) with the full envelope and payload bytes.

### Backfill topic

Each backfill gets its own topic, `backfill.<consumer>.<date>`, with the same envelope. Consumers read it with a separate consumer group and apply the same idempotency rules ([SPEC-016](@SPEC-016)): a replayed event with a lower `sequence` than already applied is skipped.

@@picture:rfc-027-backfill@@

### Rate and order

```yaml
backfill:
  consumer: notify-svc
  types: ["orders.order.confirmed.v1", "orders.order.shipped.v1"]
  from: 2025-11-01
  to: 2026-09-01
  rate_per_second: 2000
  order: by_subject_then_sequence
  missing_schema_id: resolve_by_type_and_date
```

Events without a `schema_id` get the first registry version of their type that was valid on the event's date.

## Alternatives

| Option | Effort per backfill | Risk to live traffic | Why not |
| -- | -- | -- | -- |
| One-off scripts (today) | 2 to 5 days | high | Repeated work, the October incident |
| Longer Kafka retention (90 days) | none | none | 13 times the broker storage, still not 13 months |
| Rebuild from service databases | medium | load on primaries | Databases hold state, not history |
| **Replay from ClickHouse to a backfill topic** | **under a day** | **low** | Proposed |

## Rollout

- [ ] `backfill-svc` with the YAML job format
- [ ] Rate limit and pause or resume through the job's status
- [ ] First use: `notify-svc` read model for delivery preferences
- [ ] Runbook section in [SPEC-026](@SPEC-026)

## Open questions

* Should a backfill job need a second reviewer's approval above 10 million events?
* How long do backfill topics live? Proposed: 3 days after the job ends.

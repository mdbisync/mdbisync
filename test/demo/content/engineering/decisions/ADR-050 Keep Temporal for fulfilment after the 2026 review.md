| Status | Accepted |
| -- | -- |
| Date | 2026-10-20 |
| Authors | DemoOscar |
| Reviewers | DemoMike, DemoFrank, DemoAlice |
| Reviews | [ADR-040 Use Temporal for long-running fulfilment workflows](@ADR-040) |

## Context

[ADR-040](@ADR-040) adopted Temporal for fulfilment workflows and asked for a review after a period of operation. Since June 2026 the cluster has run about 2.1 million shipment workflows. Running it costs effort: two upgrades, one incident where the history database filled its disk, and on-call needs to know one more system. The review asked whether to keep it, move to the cloud provider's workflow service, or go back to simpler code.

## Decision

We **keep Temporal** for fulfilment and extend it to scheduled jobs ([ADR-049](@ADR-049)). ADR-040 stays in force.

* The history database moves to a managed PostgreSQL instance with storage autoscaling.
* Workflow history is kept for 14 days after completion instead of 30.
* Upgrades follow the minor releases within a month, in staging first.

@@picture:adr-050-review@@

@@table:adr-050-review@@

## Options considered

| Option | Monthly cost | Migration effort | Stuck shipments in incidents | Verdict |
| -- | -- | -- | -- | -- |
| **Keep self-hosted Temporal** | **about 2,400 USD** | **none** | **0 since June** | **Chosen** |
| Temporal's hosted service | about 5,900 USD at our action volume | 2 weeks | 0 | Cost |
| Cloud provider's workflow service | about 1,800 USD | about 3 months | unknown | Rewriting 14 workflows for a small saving |
| Back to status columns and cron jobs | about 600 USD | about 2 months | 1,300 in one incident before | The problem ADR-040 solved |

## Consequences

* Fulfilment code stays as it is.
* The platform group owns Temporal upgrades; fulfilment owns the workflows.

## Follow-up

- [X] History database on managed PostgreSQL
- [X] Retention set to 14 days
- [ ] Move the remaining scheduled jobs to Temporal schedules

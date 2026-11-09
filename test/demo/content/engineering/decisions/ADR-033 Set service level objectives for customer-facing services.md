| Status | Accepted |
| -- | -- |
| Date | 2026-03-04 |
| Authors | DemoKen |
| Reviewers | DemoBob, DemoMike |
| Specification | [SPEC-008 Service level objective definitions](@SPEC-008) |

## Context

Alerts fire on CPU, memory and individual errors: 1,900 alerts in January 2026, of which on-call acted on 6 %. At the same time a checkout slowdown in February lasted 50 minutes before anyone noticed, because no single alert crossed its threshold. Nobody can say how reliable checkout should be, so nobody can say when to stop shipping and fix things.

## Decision

Every customer-facing service has **service level objectives** on availability and latency, measured from its users' side, and alerting is based on error budget burn.

* SLOs are defined as code in the format of [SPEC-008](@SPEC-008), reviewed with the product team.
* Alerts page only on fast burn (2 % of the 30-day budget in one hour) or slow burn (5 % in six hours); everything else becomes a ticket.
* When a service has used its budget for the month, its team works on reliability before features ([RFC-009](@RFC-009)).

| Service | Availability SLO (30 days) | Latency SLO |
| -- | -- | -- |
| Web shop pages | 99.9 % | 95 % under 800 ms |
| `checkout-svc` | 99.95 % | 99 % under 1,200 ms |
| `search-svc` | 99.9 % | 95 % under 300 ms |
| Public API | 99.9 % | 95 % under 500 ms |
| `notify-svc` | 99.5 % | 95 % sent within 60 s |

@@picture:adr-033-alerts@@

## Options considered

| Option | Pages per week (estimate) | Catches slow degradation | Needs product input | Verdict |
| -- | -- | -- | -- | -- |
| **SLOs with burn-rate alerts** | **3 to 5** | **yes** | **yes** | **Chosen** |
| Tuned threshold alerts | 30 | partly | no | Still noisy |
| Threshold alerts (today) | 440 | no | no | The problem we have |

## Consequences

* Fewer, more meaningful pages.
* Reliability work is planned from budgets, not from the loudest incident.

## Follow-up

- [X] SLOs for the five services above
- [X] Burn-rate alerts replace threshold alerts for those services
- [ ] SLOs for Seller Hub and the internal admin tools

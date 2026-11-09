| Status | Implemented |
| -- | -- |
| Date | 2026-02-05 |
| Authors | DemoFrank |
| Reviewers | DemoBob, DemoKen |
| Plan | [RFC-004 Moving CI to ephemeral runners](@RFC-004) |
| Evidence | [RN-003 CI pipeline duration before and after ephemeral runners](@RN-003) |

## Context

CI runs on eight long-lived self-hosted runner machines. Jobs share disks and caches, so a job can see another job's files, and flaky builds come from leftovers of earlier runs. During busy hours, jobs wait up to 14 minutes for a free runner, while at night the machines idle. A runner was compromised through a malicious dependency in a test sandbox at another company in 2025, and our runners hold deploy credentials.

## Decision

CI jobs run on **ephemeral runners**: a fresh pod in the Kubernetes `ci` node pool per job, deleted when the job ends.

* Runner pods scale from zero to 120 with the queue; the node pool autoscales on spot instances with on-demand fallback.
* Caches live in a bucket keyed by lockfile hash, not on runner disks.
* Runners hold no long-lived credentials; jobs get short-lived tokens through workload identity.
* Build containers run without privileged mode; images are built with rootless BuildKit.

@@picture:adr-031-ci-wait@@

## Options considered

| Option | Median queue wait at peak | Isolation between jobs | Monthly cost | Verdict |
| -- | -- | -- | -- | -- |
| **Ephemeral runner pods** | **35 s** | **full** | **3,100 USD** | **Chosen** |
| Hosted runners from the CI vendor | 20 s | full | 6,800 USD at our minutes | Cost, and no access to private networks |
| More self-hosted machines | 2 min | none | 4,400 USD | Does not fix isolation |
| Eight self-hosted machines (today) | 14 min | none | 2,900 USD | The problem we have |

## Consequences

* Every job starts clean; "works on runner 3" bugs disappear.
* Cold caches make the first job after a lockfile change slower, by about 2 minutes.
* The CI node pool is one more thing the platform group runs.

## Follow-up

- [X] Runner controller in the tooling cluster
- [X] Move all pipelines
- [X] Decommission the eight runner machines

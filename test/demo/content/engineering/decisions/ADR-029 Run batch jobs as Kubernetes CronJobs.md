| Status | Superseded |
| -- | -- |
| Date | 2026-01-09 |
| Authors | DemoFrank |
| Reviewers | DemoBob, DemoKen |
| Superseded by | [ADR-049 Replace nightly reconciliation with streaming reconciliation](@ADR-049) |

> [!NOTE]
> Superseded in October 2026 by ADR-049: payment reconciliation, the largest of these jobs, became a streaming consumer, and the remaining jobs moved to Temporal schedules ([ADR-040](@ADR-040)).

## Context

Eleven batch jobs (payment reconciliation, payout files, sitemap generation, stale cart clean-up and others) run from a crontab on one virtual machine, the last one left after the move to Kubernetes ([ADR-002](@ADR-002)). When that machine was patched in December, two jobs did not run and nobody noticed for three days.

## Decision

Batch jobs run as **Kubernetes CronJobs** in the `batch` node pool.

* Each job is a container image built like any service, with its schedule in the environments repository ([ADR-008](@ADR-008)).
* `concurrencyPolicy: Forbid`; a job that runs longer than its interval is an alert, not a second copy.
* Every run reports success or failure as a metric; an alert fires when a job has not succeeded within 1.5 times its interval.
* The batch node pool uses spot instances ([RFC-014](@RFC-014)); jobs must be safe to restart.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: payment-reconciliation
spec:
  schedule: "15 2 * * *"
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 900
  jobTemplate:
    spec:
      backoffLimit: 3
      activeDeadlineSeconds: 5400
```

## Options considered

| Option | Missed runs noticed | Restartable | New components | Verdict |
| -- | -- | -- | -- | -- |
| **Kubernetes CronJobs** | **within 1.5 intervals** | **yes** | **none** | **Chosen** |
| A workflow engine | yes | yes | engine | Not needed for eleven simple jobs at the time |
| Crontab on a VM (today) | no | no | none | The problem we have |

## Consequences

* The last virtual machine is switched off.
* Jobs that run for hours, like reconciliation, block the spot pool and fail on interruption; this later led to [ADR-049](@ADR-049).

## Follow-up

- [X] Move all eleven jobs
- [X] Missed-run alerts
- [X] Switch off the batch VM

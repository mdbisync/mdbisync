| Status | Accepted |
| -- | -- |
| Created | 2026-01-13 |
| Authors | DemoNina |
| Reviewers | DemoErin, DemoMike |
| Target | Q2 2026 |
| Decision | [ADR-029 Run batch jobs as Kubernetes CronJobs](@ADR-029) |

## Summary

Run batch jobs, CI runners and other interruptible work on a separate node pool of spot instances, which cost about a third of on-demand instances, and make every job safe to restart.

## Motivation

Batch work (report exports, search reindexing, image backfills, CI) used 31 % of all node hours in December 2025, all on on-demand instances. None of it is customer-facing in real time, and most of it already retries on failure. At current prices, moving it to spot would save about 14,000 USD a month.

## Proposal

@@picture:rfc-014-pools@@

### Node pools

| Pool | Instances | Workloads | Taint |
| -- | -- | -- | -- |
| `general` | on-demand | services | none |
| `batch-spot` | spot, 6 instance types | CronJobs, reindexing | `spot=true:NoSchedule` |
| `ci` | spot, 3 instance types | CI runners ([RFC-004](@RFC-004)) | `ci=true:NoSchedule` |

Using several instance types lowers the chance that all capacity is reclaimed at once ([RN-007](@RN-007)).

### Jobs must be restartable

A spot instance gets a two-minute warning before it is reclaimed. The node drains, and the job's pod gets SIGTERM. A job on `batch-spot` must:

* save progress at least every 5 minutes (a cursor or offset), and resume from it;
* finish its current unit of work within 90 seconds of SIGTERM;
* set `backoffLimit: 4` so Kubernetes restarts it on another node.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: search-reindex
spec:
  schedule: "15 2 * * *"
  jobTemplate:
    spec:
      backoffLimit: 4
      template:
        spec:
          tolerations:
            - key: spot
              operator: Equal
              value: "true"
              effect: NoSchedule
          nodeSelector:
            demomart.example.com/pool: batch-spot
          terminationGracePeriodSeconds: 90
```

## Alternatives

| Option | Saving per month | Why not |
| -- | -- | -- |
| Reserved instances for batch | about 5,000 USD | Commits to capacity used only at night |
| **Spot pool, restartable jobs** | **about 14,000 USD** | Chosen |
| Spot for services too | more | Customer-facing latency at risk |

## Rollout

- [X] `ci` pool on spot ([RFC-004](@RFC-004))
- [X] `batch-spot` pool with six instance types
- [ ] Reindex and export jobs made restartable, moved
- [ ] Remaining CronJobs moved; on-demand fallback only for the payment reconciliation job

## Open questions

* The payment reconciliation job must finish before 06:00 for finance; it stays on on-demand until [ADR-049](@ADR-049) replaces it with streaming reconciliation.

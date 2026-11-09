| Status | Implemented |
| -- | -- |
| Created | 2025-12-09 |
| Authors | DemoMike |
| Reviewers | DemoErin, DemoFrank |
| Target | Q1 2026 |
| Decision | [ADR-031 Replace self-hosted CI runners with ephemeral runners](@ADR-031) |

## Summary

Run every CI job on a fresh runner pod that exists only for that job, created on Kubernetes by the Actions Runner Controller, instead of on twelve long-lived virtual machines.

## Motivation

The twelve runner machines are shared by all jobs and never reset. Measured over October and November 2025:

* 9 % of failed builds failed because of state left by an earlier job: a full disk, a stale Docker cache, a port still in use.
* At 10:00 to 12:00 on weekdays, jobs waited a median of 6 minutes for a free runner, while at night the machines were idle.
* The machines cost 3,100 USD a month whether used or not.

## Proposal

Install the Actions Runner Controller in a dedicated `ci` node pool on spot instances ([RFC-014](@RFC-014)). Each job gets a new pod from a runner image; the pod is deleted when the job ends.

@@picture:rfc-004-runners@@

### Runner sizes

| Label | CPU | Memory | Used by |
| -- | -- | -- | -- |
| `runner-small` | 2 | 4 GiB | lint, unit tests, docs |
| `runner-medium` | 4 | 8 GiB | Go builds, service tests |
| `runner-large` | 8 | 16 GiB | web shop build, end-to-end tests |

### Caching

Without a persistent disk, caches move to an object storage bucket: Go modules and build cache, npm cache and Docker layers through a registry cache.

```yaml
jobs:
  test:
    runs-on: runner-medium
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true
      - run: go test ./...
```

## Alternatives

| Option | Clean state | Waiting at peak | Monthly cost | Why not |
| -- | -- | -- | -- | -- |
| Long-lived machines (today) | no | 6 min | 3,100 USD | The problem |
| Hosted runners from the CI provider | yes | under 1 min | about 5,800 USD | Twice the cost at our volume |
| **Ephemeral pods on spot nodes** | **yes** | **under 1 min** | **about 1,700 USD** | Chosen |

## Rollout

- [X] Controller and runner images in the `ci` node pool
- [X] Cache bucket and registry cache
- [X] All repositories move in two waves
- [X] Old machines deleted
- [X] Compare duration and failures before and after ([RN-003](@RN-003))

## Open questions

* A spot interruption kills a running job. The controller retries it once on a new pod; [RN-007](@RN-007) shows how often that happens.

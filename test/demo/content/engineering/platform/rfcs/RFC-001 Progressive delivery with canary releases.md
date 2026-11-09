| Status | Implemented |
| -- | -- |
| Created | 2025-09-02 |
| Authors | DemoErin |
| Reviewers | DemoAlice, DemoFrank, DemoKen |
| Target | Q4 2025 |
| Decision | [ADR-022 Ship every user-facing change behind a feature flag](@ADR-022) |

## Summary

Release every service version to a small share of traffic first, compare it with the current version for 30 minutes, and promote or roll back automatically based on error rate and latency.

## Motivation

Argo CD replaces all pods of a service at once ([ADR-008](@ADR-008)). In the first half of 2025, 11 of 214 production releases caused a customer-visible problem, and the median time to roll back was 23 minutes, most of it spent noticing. Feature flags ([ADR-022](@ADR-022)) cover product changes, but not a new library version, a changed query or a memory leak. Those reach every buyer at once.

## Proposal

Use Argo Rollouts for every service that takes customer traffic. A rollout moves traffic in steps and runs an analysis between them.

@@picture:rfc-001-canary-steps@@

### Steps

| Step | Traffic to the new version | Minimum time | Gate |
| -- | -- | -- | -- |
| 1 | 5 % | 10 min | analysis passes |
| 2 | 25 % | 10 min | analysis passes |
| 3 | 50 % | 10 min | analysis passes |
| 4 | 100 % | | done |

### Analysis

The analysis compares the canary with the stable pods over the same window, using the metrics in [SPEC-012](@SPEC-012). A step fails when the canary's error rate is more than 0.5 percentage points above stable, or its p99 latency more than 20 % above stable.

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: http-canary
spec:
  metrics:
    - name: error-rate-delta
      interval: 1m
      failureLimit: 2
      successCondition: result[0] < 0.005
      provider:
        prometheus:
          query: |
            canary_error_ratio{service="{{args.service}}"}
              - stable_error_ratio{service="{{args.service}}"}
```

### Rollback

A failed analysis sets traffic to the new version to 0 % within one minute and marks the rollout as aborted. Argo CD shows the service as degraded until a new commit arrives.

## Alternatives

| Option | Detects | Time to roll back | Effort | Why not |
| -- | -- | -- | -- | -- |
| Manual canary with a second Deployment | what people notice | 15 to 30 min | small | Depends on someone watching |
| Blue-green switch | startup failures | 1 min | medium | All traffic moves at once |
| **Argo Rollouts with analysis** | **error rate and latency** | **1 min** | **medium** | Chosen |
| Feature flags only | product regressions | instant | done | Does not cover infrastructure changes |

## Rollout

- [X] Argo Rollouts installed in staging and production
- [X] Analysis template with the metrics of [SPEC-012](@SPEC-012)
- [X] `checkout-svc`, `cart-svc` and `search-svc` on canaries
- [X] All customer-facing services on canaries
- [X] Review the first six months ([RN-001](@RN-001))

## Open questions

* Services with low traffic at night get too few requests in 10 minutes for a fair comparison. For now they use the same steps with 20-minute windows between 00:00 and 06:00.

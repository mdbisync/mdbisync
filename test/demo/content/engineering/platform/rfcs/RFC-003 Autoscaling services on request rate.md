| Status | Accepted |
| -- | -- |
| Created | 2025-11-04 |
| Authors | DemoKen |
| Reviewers | DemoErin, DemoFrank |
| Target | Q1 2026 |
| Evidence | [RN-005 Autoscaling on CPU versus request rate](@RN-005) |

## Summary

Scale customer-facing services on requests per second per pod, measured at the service, instead of on CPU utilisation.

## Motivation

All services scale on 70 % CPU today. For services that mostly wait on databases or other services, CPU rises late: during the November 2025 sale, `checkout-svc` reached 2.4 times its normal traffic in 4 minutes, CPU crossed the threshold 3 minutes later, and the new pods were ready another 90 seconds after that. p99 latency was above 1 second for 6 minutes. [RN-005](@RN-005) replayed that traffic: scaling on request rate kept p99 under 400 ms.

## Proposal

Use KEDA with a Prometheus trigger on `http_server_requests_per_second` per pod. Each service declares the rate one pod handles comfortably, measured in a load test ([ADR-046](@ADR-046)).

@@picture:rfc-003-scaling@@

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: checkout-svc
spec:
  scaleTargetRef:
    name: checkout-svc
  minReplicaCount: 4
  maxReplicaCount: 60
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 300
  triggers:
    - type: prometheus
      metadata:
        query: sum(rate(http_server_requests_total{service="checkout-svc"}[1m]))
        threshold: "180"
```

### Targets per service

| Service | Requests per pod | Minimum pods | Maximum pods |
| -- | -- | -- | -- |
| `checkout-svc` | 180 | 4 | 60 |
| `cart-svc` | 400 | 4 | 40 |
| `search-svc` | 250 | 6 | 80 |
| `catalog-svc` | 600 | 3 | 30 |

Services that do heavy computation (`reco-svc`, image resizing) keep CPU as a second trigger; KEDA takes the higher of the two.

## Alternatives

| Option | Reacts to a 2.4 times spike in | Why not |
| -- | -- | -- |
| CPU at 70 % (today) | 4.5 min | Too slow for I/O-bound services |
| CPU at 40 % | 2 min | Pays for idle pods all day |
| Scheduled scaling before sales | before the spike | Only for known events |
| **Request rate per pod** | **1.5 min** | Chosen; keep scheduled scaling for big sales |

## Rollout

- [X] KEDA installed in staging and production
- [X] `checkout-svc` on request rate in staging; replay of the November sale
- [ ] `checkout-svc`, `cart-svc` and `search-svc` in production
- [ ] Remaining customer-facing services
- [ ] Remove CPU-only autoscalers

## Open questions

* The per-pod target must be updated when a service gets faster or slower. A load test result older than 90 days will show as a warning in the service catalogue.

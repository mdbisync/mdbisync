| Status | Implemented |
| -- | -- |
| Created | 2026-07-21 |
| Authors | DemoAlice, DemoKen |
| Reviewers | DemoCarol, DemoErin, DemoLaura |
| Target | Q3 2026 |
| Decision | [ADR-048 Run checkout active-passive across two regions](@ADR-048) |

## Summary

Keep a warm copy of the checkout path in a second region and fail over to it within 15 minutes if the primary region is lost, losing at most 1 minute of committed orders.

## Motivation

All of DemoMart runs in one region. The cloud provider's region-wide incident in April 2026 took the shop down for 2 hours 40 minutes, during which about 18,000 orders could not be placed. Browsing can degrade, but checkout is where revenue is lost. A full active-active setup for every service would double the infrastructure bill.

## Proposal

Only the checkout path is replicated: `cart-svc`, `checkout-svc`, `demo-pay`, `orders-svc`, `identity-svc` and their databases. The second region runs them scaled down, with databases kept current by streaming replication.

@@picture:rfc-015-regions@@

### Targets

| Measure | Target | Measured in the September 2026 drill |
| -- | -- | -- |
| Recovery time | 15 min | 11 min ([RN-014](@RN-014)) |
| Recovery point (orders lost) | 1 min | 9 s of replication lag |
| Standby cost | under 25 % of the primary path | 19 % |

### Failover steps

1. The on-call engineer declares a regional failure (failover is never automatic).
2. Promote the standby PostgreSQL clusters.
3. Scale the standby services to production size (KEDA minimums raised).
4. Switch DNS for `checkout.demomart.example.com` to the standby region's load balancer, TTL 60 s.
5. Browsing pages in the standby region serve from the CDN cache ([ADR-035](@ADR-035)).

```sh
demo-platform failover checkout --to region-b --confirm
```

## Alternatives

| Option | Recovery time | Extra cost | Why not |
| -- | -- | -- | -- |
| One region (before) | hours | none | The problem |
| Active-active for everything | seconds | about 100 % | Cost and data consistency |
| **Active-passive for checkout** | **15 min** | **19 %** | Chosen |
| Backups restored in another region | 4 to 6 hours | small | Too slow ([RN-021](@RN-021)) |

## Rollout

- [X] Standby region with Terraform modules ([ADR-009](@ADR-009))
- [X] Streaming replication for the checkout databases
- [X] Failover command and runbook
- [X] First drill in staging, then in production in September 2026 ([RN-014](@RN-014))
- [ ] Quarterly drills

## Open questions

* Kafka is not replicated; order events written during a failover are published again from the outbox ([ADR-014](@ADR-014)) after the switch.

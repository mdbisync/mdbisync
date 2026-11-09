| Status | Proposed |
| -- | -- |
| Date | 2026-09-23 |
| Authors | DemoMike |
| Reviewers | DemoBob, DemoKen, DemoOscar |
| Plan | [RFC-015 Multi-region failover for checkout](@RFC-015) |
| Evidence | [RN-014 Failover drill results for checkout](@RN-014) |

## Context

Checkout runs in one region. Our cloud region had two partial outages in 2026, of 47 and 95 minutes, and checkout was down for both. At an average of 310 orders a minute in the evening, that is about 44,000 orders not taken. Browsing already works from a second region; paying does not.

## Decision

We propose to run checkout **active-passive across two regions**: the primary region takes all traffic, the secondary runs warm and takes over within 5 minutes.

* Services in the checkout path (`cart-svc`, `checkout-svc`, `demo-pay`, `orders-svc`) run in both regions at 25 % capacity in the secondary, scaled up on failover.
* PostgreSQL uses cross-region asynchronous replicas; the recovery point objective is 30 seconds, the recovery time objective 5 minutes.
* Redis carts replicate across regions; carts changed in the last seconds before a failover may be lost.
* Failover is a manual decision with one command; it is drilled every quarter ([RN-014](@RN-014)).

@@picture:adr-048-regions@@

## Options considered

| Option | Downtime in a region outage | Lost orders in a failover | Extra monthly cost | Verdict |
| -- | -- | -- | -- | -- |
| **Active-passive, warm secondary** | **about 5 min** | **up to 30 s of orders, reconciled** | **about 11,000 USD** | **Proposed** |
| Active-active with a global database | none | none | about 32,000 USD | Cost and write latency of a global database |
| Cold standby from backups | 2 to 4 h | up to 5 min | about 2,000 USD | Too slow for checkout |
| One region (today) | the whole outage | none, but no orders taken | none | The problem we have |

## Consequences

* A failover can lose up to 30 seconds of orders; reconciliation with payment providers ([ADR-049](@ADR-049)) finds and repairs them.
* Every change to the checkout path must work in both regions; the pipeline deploys to both.

## Follow-up

- [ ] Agree on the cost with finance
- [ ] Cross-region replicas for the four databases
- [ ] First full drill in the secondary region

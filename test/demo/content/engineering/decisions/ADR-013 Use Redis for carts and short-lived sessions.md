| Status | Accepted |
| -- | -- |
| Date | 2025-06-06 |
| Authors | DemoJudy |
| Reviewers | DemoDave, DemoMike |

## Context

Carts are rows in `cart-svc`'s PostgreSQL database. During the spring sale, cart writes peaked at 6,200 per second; the database's CPU reached 92 % and checkout slowed. 71 % of carts are abandoned within a day and never read again, yet each one is stored, vacuumed and backed up. Sign-in sessions sit in the same database.

## Decision

Carts and sessions live in **Redis** (managed, with replication across two zones).

* A cart is one hash per cart id, with a 30-day expiry renewed on every change; guest carts expire after 7 days.
* Sessions are keys with a 12-hour sliding expiry.
* When an order is placed, `checkout-svc` copies the cart into the order in PostgreSQL; the cart in Redis is then deleted. Data model in [SPEC-046](@SPEC-046).
* Redis persistence: append-only file, fsync every second. Losing up to one second of cart changes is acceptable; losing orders is not, and orders never live only in Redis.

```text
HSET cart:7f3e9c line:p_81:v_2 '{"qty":2,"unit_price":2499,"currency":"EUR"}'
EXPIRE cart:7f3e9c 2592000
```

## Options considered

| Option | Writes per second at 50 % CPU | p99 write latency | Durability | Verdict |
| -- | -- | -- | -- | -- |
| **Redis, replicated** | **95,000** | **1.2 ms** | **up to 1 s of loss** | **Chosen** |
| PostgreSQL with unlogged tables | 9,000 | 4.8 ms | lost on crash | Still the same database |
| Larger PostgreSQL instance | 8,500 | 6.1 ms | full | Twice the cost for data we throw away |
| A document database | 30,000 | 3.5 ms | full | Another engine for little gain |

## Consequences

* The cart load leaves the transactional database.
* Abandoned carts clean themselves up through expiry.
* Offline carts in the app ([RFC-065](@RFC-065)) merge into the Redis cart on sign-in.

## Follow-up

- [X] Carts in Redis behind a feature flag
- [X] Sessions in Redis
- [ ] Drop the old cart tables after 60 days

| Status | Accepted |
| -- | -- |
| Created | 2026-02-10 |
| Authors | DemoNina |
| Reviewers | DemoErin, DemoKen, DemoGrace |
| Target | Q2 2026 |
| Decision | [ADR-034 Use a token bucket for API rate limits](@ADR-034) |

## Summary

Replace the single limit of 600 requests per minute per partner with token buckets per partner and endpoint class, sized from real usage, and tell clients their budget in every response.

## Motivation

One limit for everything treats a catalog scan and an order confirmation the same. In January 2026:

* Partners with large catalogs used their whole minute on `GET /v2/products` and then had order calls refused: 61 % of `429` responses hit order and refund endpoints.
* A single misbehaving client spent its budget in the first 4 seconds of each minute and caused bursts of 2,400 requests per second at the gateway.
* Partners could not see their remaining budget, so they guessed and backed off too much or too little.

## Proposal

### Endpoint classes

| Class | Endpoints | Rate per partner | Burst |
| -- | -- | -- | -- |
| Read | `GET` on products, inventory, orders | 20 per second | 200 |
| Write | `POST`, `PATCH`, `DELETE` on products and inventory | 10 per second | 50 |
| Order actions | order confirmations, shipments, refunds | 10 per second | 20 |
| Bulk | import jobs ([SPEC-041](@SPEC-041)) | 1 per 10 seconds | 3 |

Each partner and class has a token bucket. The rate refills it, the burst is its size. A partner can ask for higher limits; Seller Hub shows the current ones.

@@picture:rfc-033-layers@@

### Implementation

Buckets live in Redis next to the gateway, one key per partner and class, updated by a Lua script in one round trip:

```lua
local tokens = tonumber(redis.call("HGET", KEYS[1], "t") or ARGV[2])
local last = tonumber(redis.call("HGET", KEYS[1], "ts") or ARGV[3])
local now, rate, burst = tonumber(ARGV[3]), tonumber(ARGV[1]), tonumber(ARGV[2])
tokens = math.min(burst, tokens + (now - last) * rate)
local allowed = tokens >= 1
if allowed then tokens = tokens - 1 end
redis.call("HSET", KEYS[1], "t", tokens, "ts", now)
redis.call("PEXPIRE", KEYS[1], 60000)
return { allowed and 1 or 0, math.floor(tokens) }
```

Responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`, and a `429` carries `Retry-After` ([SPEC-034](@SPEC-034)). If Redis is unreachable the gateway allows the request and counts locally, so an outage of the limiter never becomes an outage of the API.

## Alternatives

| Option | Bursts | Memory per partner | Fairness | Verdict |
| -- | -- | -- | -- | -- |
| Fixed window per minute (today) | double at window edges | 1 counter | poor | Being replaced |
| Sliding log | exact | one entry per request | good | Too much memory at 20 per second |
| Sliding window counter | smoothed | 2 counters | good | Close second ([RN-032](@RN-032)) |
| **Token bucket** | **allowed up to the burst** | **2 values** | **good** | Chosen |

## Rollout

- [X] Limiter in shadow mode: log what would be refused
- [X] Limits per class reviewed against two weeks of traffic ([RN-029](@RN-029))
- [ ] Headers in every response
- [ ] Enforce for new partners
- [ ] Enforce for all partners, with 30 days' notice

## Open questions

* Should the sandbox ([SPEC-043](@SPEC-043)) use lower limits than production to surface retry bugs early?

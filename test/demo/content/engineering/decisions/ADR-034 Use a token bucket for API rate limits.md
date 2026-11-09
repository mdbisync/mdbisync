| Status | Implemented |
| -- | -- |
| Date | 2026-03-17 |
| Authors | DemoJudy |
| Reviewers | DemoHeidi, DemoKen |
| Plan | [RFC-033 Rate limits per partner and endpoint](@RFC-033) |
| Evidence | [RN-032 Rate limit algorithms compared](@RN-032) |

## Context

The public API limits each partner to 600 requests per minute in a fixed window. Partners syncing inventory send bursts at the start of each minute, hit the limit after 3 seconds and wait 57; at the window boundary they can send 1,200 requests in two seconds. Inventory updates and order reads share one limit, so a partner's catalog import blocks its order processing.

## Decision

Rate limits use a **token bucket per partner application and endpoint group**, enforced in `api-gateway` with state in Redis.

* Endpoint groups: `orders`, `inventory`, `catalog`, `bulk` and `other`, each with its own bucket.
* Default bucket: capacity 120 tokens, refill 10 tokens per second; the `bulk` group has capacity 10, refill 1 per 10 seconds.
* Responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers, and `429` with `Retry-After` when empty ([SPEC-034](@SPEC-034)).
* The bucket check is one Lua script in Redis, atomic per key.

```lua
local tokens = tonumber(redis.call("HGET", KEYS[1], "t") or ARGV[1])
local last   = tonumber(redis.call("HGET", KEYS[1], "ts") or ARGV[3])
tokens = math.min(tonumber(ARGV[1]), tokens + (ARGV[3] - last) * ARGV[2])
if tokens < 1 then return 0 end
redis.call("HSET", KEYS[1], "t", tokens - 1, "ts", ARGV[3])
redis.call("PEXPIRE", KEYS[1], 120000)
return 1
```

## Options considered

| Option | Allows short bursts | Boundary spikes | Redis calls per request | Verdict |
| -- | -- | -- | -- | -- |
| **Token bucket** | **yes, up to capacity** | **none** | **1** | **Chosen** |
| Sliding window log | no | none | 2 and more memory | Memory grows with the limit |
| Sliding window counter | partly | small | 2 | Harder to explain to partners |
| Fixed window (today) | no | up to 2 times the limit | 1 | The problem we have |

[RN-032](@RN-032) replayed a day of partner traffic against each algorithm.

## Consequences

* Partners can burst briefly and then run at a steady rate.
* A heavy catalog import no longer blocks order processing.

## Follow-up

- [X] Token buckets in `api-gateway`
- [X] Rate limit headers documented
- [X] Per-partner overrides in the admin tool

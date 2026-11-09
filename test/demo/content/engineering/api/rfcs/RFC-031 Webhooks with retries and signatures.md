| Status | Implemented |
| -- | -- |
| Created | 2025-07-08 |
| Authors | DemoFrank |
| Reviewers | DemoErin, DemoNina, DemoHeidi |
| Target | Q3 2025 |
| Decision | [ADR-018 Sign webhooks with HMAC-SHA256](@ADR-018) |

## Summary

Deliver webhooks from one place, `notify-svc`, with a signature on every request, retries on a fixed schedule for 72 hours, and a per-subscription view of what was delivered. Replace the five services that post webhooks today, each in its own way.

## Motivation

Partners learn about orders, shipments and refunds through webhooks. In June 2025:

* Five services sent webhooks, with three retry policies and two without any retry.
* Only order webhooks were signed, with a shared secret per partner that could not be rotated without downtime.
* 2.3 % of deliveries failed for good, most of them during short partner outages that a retry an hour later would have survived ([RN-030](@RN-030)).
* Partners polled `GET /v1/orders` every minute "just in case", which made up 38 % of all API calls ([RN-029](@RN-029)).

## Proposal

### Delivery

Services publish domain events to Kafka as they do today ([ADR-005](@ADR-005)). `notify-svc` matches each event against webhook subscriptions and queues one delivery per match.

@@picture:rfc-031-delivery@@

A delivery succeeds on any `2xx` within 10 seconds. Anything else is retried after 1 min, 5 min, 30 min, 2 h, 6 h, 12 h and then every 12 h until 72 hours have passed. After that the delivery is marked failed and the partner can replay it ([RFC-042](@RFC-042)). A subscription whose deliveries all fail for 5 days is paused, and the partner is told in Seller Hub and by an API status flag.

### Signature

Every request carries a timestamp and an HMAC-SHA256 over the timestamp and the raw body:

```http
POST /hooks/demomart HTTP/1.1
Host: partner.example.com
Content-Type: application/json
DemoMart-Webhook-Id: whk_01J9Z3V4Q8
DemoMart-Webhook-Timestamp: 1767225600
DemoMart-Webhook-Signature: v1=5f0c1e9d2b7a4c3e8f6a1d0b9c8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e
```

The signed string is `<timestamp>.<raw body>`. A subscription can have two active secrets during rotation, and then the header carries two `v1=` values. Receivers reject timestamps older than 5 minutes. The details are in [SPEC-039](@SPEC-039).

### Ordering and duplicates

Deliveries for one subject (one order, one product) are sent in event order; the next waits until the previous one succeeded or failed for good. Every delivery has a stable `DemoMart-Webhook-Id`, so a receiver can drop duplicates.

## Alternatives

| Option | Retries | Signed | Effort | Why not |
| -- | -- | -- | -- | -- |
| Keep webhooks in each service | per service | partly | none | The problem we have |
| A hosted webhook service | yes | yes | small | Sends partner data to another processor; costs grow per message |
| Event streaming to partners | partner pulls | by TLS | large | Most partners run small web apps, not stream consumers |
| **notify-svc with Kafka input** | **72 h schedule** | **HMAC-SHA256** | **medium** | Chosen |

## Rollout

- [X] `notify-svc` delivers order webhooks in shadow mode and compares with `orders-svc`
- [X] Signing with rotation for all event types
- [X] All five services stop posting webhooks themselves
- [X] Delivery log in Seller Hub and in `GET /v2/webhook-subscriptions/{id}/deliveries`
- [X] Paused-subscription notice

## Open questions

* Should partners choose their own retry window? Not now: the fixed 72 hours covered 99.6 % of recoverable failures in [RN-030](@RN-030).

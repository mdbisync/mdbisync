| Status | Draft |
| -- | -- |
| Created | 2026-09-08 |
| Authors | DemoFrank |
| Reviewers | DemoNina, DemoCarol |
| Target | Q1 2027 |
| Decision | Pending |

## Summary

Let partners replay webhook deliveries for a time range or a list of events, from the API and from Seller Hub, for up to 30 days back. A replay sends the original payloads again with new delivery ids and a `replay` flag.

## Motivation

A delivery that failed for 72 hours is given up ([RFC-031](@RFC-031)). Partners recover today by asking support to resend, which took a median of 2 days in Q2 2026, or by re-reading orders through the API, which most partners do not have code for.

* 0.14 % of deliveries end as failed, 4,900 a month, mostly from partners whose endpoint was down over a weekend ([RN-030](@RN-030)).
* Support handled 86 resend requests in Q2 2026, each a manual database query.
* Partners that deploy a bug in their webhook handler want the last day of events again after the fix, even though we delivered them successfully.

## Proposal

### API

```http
POST /v2/webhook-subscriptions/whs_01J7K9/replays HTTP/1.1
Host: api.example.com
Authorization: Bearer dm_test_8f2c41
Idempotency-Key: 1f4c9b7e-2d6a-4f3b-8c1e-0a9d8b7c6e5f
Content-Type: application/json

{
  "from": "2026-09-05T00:00:00Z",
  "to": "2026-09-07T00:00:00Z",
  "event_types": ["order.paid", "order.shipped"],
  "only_failed": false
}
```

The response is a replay job (`rpl_...`) with a status and a count. Events are re-sent in their original order per subject, at most 20 per second per subscription, through the same signing and retry path. Each replayed request carries `DemoMart-Webhook-Replay: true` and the original event id, so a receiver that already processed it can skip it.

@@picture:rfc-042-replay@@

### Storage

Delivered payloads are kept for 30 days in a compressed table partitioned by day. At current volume that is about 420 GB; with ZSTD compression we expect 95 GB.

## Alternatives

| Option | Partner effort | Our cost | Why not |
| -- | -- | -- | -- |
| Support resends (today) | ticket, 2 days | manual work | Slow and does not scale |
| Partners re-read via the API | code per resource | none | Many partners only consume webhooks |
| Events API with a cursor | new consumer | medium | A second integration style to support |
| **Replay jobs** | **one call** | **95 GB storage** | Proposed |

## Rollout

- [ ] Payload store with 30 days of retention
- [ ] Replay jobs in the API
- [ ] Replay button in the Seller Hub delivery log
- [ ] Remove the manual support procedure

## Open questions

* Should replays count against the partner's rate limits for webhooks? Proposed: separate budget of 20 per second.
* 30 days or 7? 30 matches the dispute window for orders.

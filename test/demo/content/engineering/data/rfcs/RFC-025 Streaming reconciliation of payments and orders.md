| Status | Accepted |
| -- | -- |
| Created | 2026-08-11 |
| Authors | DemoPeggy |
| Reviewers | DemoCarol, DemoErin, DemoIvan |
| Target | Q4 2026 |
| Decision | [ADR-049 Replace nightly reconciliation with streaming reconciliation](@ADR-049) |

## Summary

Match every payment event with its order event as they arrive, instead of comparing two database exports every night, and raise a mismatch within minutes rather than the next morning.

## Motivation

The nightly job exports payments from `demo-pay` and orders from `orders-svc` and joins them. In Q2 2026:

* It found 1,240 mismatches, 71 % of them resolved on their own within an hour (late events, not errors).
* Real mismatches (captured payment, cancelled order) waited 14 hours on average before anyone saw them; buyers noticed first in 38 cases.
* The job runs 2 h 10 min and reads both primaries during the backup window.

## Proposal

### Matching

A new consumer `recon-svc` reads [payment events](@SPEC-019) and [order events](@SPEC-017), keyed by order id, and keeps one small state record per open order in Kafka Streams state stores.

@@picture:rfc-025-recon@@

| Payment state | Order state | After | Result |
| -- | -- | -- | -- |
| captured | confirmed | at once | matched, state dropped |
| captured | cancelled | 15 min | mismatch: refund due |
| captured | none | 30 min | mismatch: orphan payment |
| none | confirmed | 30 min | mismatch: unpaid order |
| refunded | cancelled | at once | matched, state dropped |

### Mismatch output

Mismatches go to the topic `recon.mismatches` and into a queue in the payments operations console.

```protobuf
message ReconMismatch {
  string order_id = 1;
  string kind = 2;          // refund_due, orphan_payment, unpaid_order
  int64 amount_minor = 3;
  string currency = 4;
  google.protobuf.Timestamp detected_at = 5;
}
```

### Safety net

The nightly job keeps running, read-only and on the analytics copy in ClickHouse, for 60 days. Any mismatch it finds that `recon-svc` missed is a bug.

## Alternatives

| Option | Time to detect | Load on primaries | Why not |
| -- | -- | -- | -- |
| Nightly job (today) | 14 h average | 2 h of reads | Too slow |
| Run the nightly job hourly | 1 h | 24 times more reads | Load |
| **Streaming match** | **15 to 30 min** | **none** | Chosen |
| Synchronous check in checkout | at once | per request | Couples checkout to two services' state |

## Rollout

- [X] `recon-svc` in staging with replayed events from Q2 2026
- [ ] Shadow mode in production: compare with the nightly job for 30 days
- [ ] Operations console queue
- [ ] Nightly job moved to ClickHouse, then removed after 60 clean days

## Open questions

* The 30-minute window is a guess from Q2 data. Should it differ by payment method? Bank transfers can take a day.

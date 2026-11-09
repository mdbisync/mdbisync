| Status | Accepted |
| -- | -- |
| Created | 2026-02-03 |
| Authors | DemoHeidi |
| Reviewers | DemoKen, DemoCarol, DemoDave |
| Target | Q2 2026 |
| Decision | [ADR-038 Route all payments through one payment orchestrator](@ADR-038) |

## Summary

When a card payment fails with a soft decline, let `demo-pay` retry it up to four times within 10 minutes on a schedule chosen by the decline reason, while the buyer waits on the payment page with a progress message.

## Motivation

3.2 % of card attempts end in a soft decline, a decline the network marks as retryable. Today the buyer sees "payment failed" and 46 % of them leave. The trial in [RN-044](@RN-044) recovered 33.1 % of soft declines with a reason-based schedule, about 6,500 orders a quarter.

## Proposal

@@picture:rfc-050-retry@@

### Schedule by reason

```yaml
retry_schedules:
  issuer_unavailable:   [2s, 5s, 15s, 45s]
  do_not_honour:        [10s, 30s, 90s]
  velocity_limit:       [30s, 90s]
  insufficient_funds:   [60s]
  authentication_required: []   # never retried; start a 3-D Secure challenge
  default:              [5s, 20s]
total_budget: 10m
```

### Rules

* The same idempotency key is reused for every retry ([SPEC-035](@SPEC-035) describes keys on the public API; `demo-pay` follows the same rules internally).
* No retry after a hard decline, after the buyer leaves the page, or after the payment intent is cancelled.
* Each attempt is a separate authorisation record on the payment intent ([SPEC-048](@SPEC-048)), so reconciliation sees all of them ([ADR-049](@ADR-049)).
* Card network rules limit retries of one card to 15 in 30 days; `demo-pay` counts them per card token.

### What the buyer sees

"Your bank did not respond. Trying again..." with a cancel button. After the budget runs out, the page offers the other payment methods.

## Alternatives

| Option | Recovered declines | Why not |
| -- | -- | -- |
| No retries (today) | 0 % | Lost orders |
| Fixed 30 s delay | 21.4 % | Worse than by reason ([RN-044](@RN-044)) |
| Retry later in the background, email the buyer | not measured | The buyer has left; order no longer certain |
| **Schedule by reason** | **33.1 %** | Chosen |

## Rollout

- [X] Retry planner in `demo-pay` behind `payments.soft_retry`
- [ ] 20 % of buyers for two weeks, compare fraud and chargeback rates
- [ ] All buyers
- [ ] Monthly report of retries per card against the network limit

## Open questions

* Should the app keep the retry running if the buyer moves it to the background? Leaning yes, with a push message when the order is placed.

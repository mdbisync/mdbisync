| Status | In review |
| -- | -- |
| Created | 2026-08-25 |
| Authors | DemoHeidi, DemoLaura |
| Reviewers | DemoKen, DemoOscar |
| Target | Q4 2026 |
| Evidence | [RN-050 Refund processing times](@RN-050) |

## Summary

Approve refunds automatically when rules allow it, so buyers get their money back without waiting for support or the seller. Extend the June pilot from orders under 50 EUR to orders up to 150 EUR with a confirmed return.

## Motivation

Before the pilot a card refund took a median of 6.8 days, of which 52 hours were waiting for someone to approve it ([RN-050](@RN-050)). In the pilot the wait for approval fell to minutes and card refunds took 3.2 days. Refunds are 18 % of support contacts.

## Proposal

@@picture:rfc-053-refund@@

### Rules

| Rule | Automatic approval when |
| -- | -- |
| Amount | Refund up to 150 EUR |
| Return | The seller or the carrier confirmed the parcel arrived back |
| Buyer history | Fewer than 3 refunds in 90 days |
| Payment | Not under a chargeback |
| Seller | The seller has not opted out for this listing category |

Requests that fail a rule go to the seller in Seller Hub ([SPEC-084](@SPEC-084)), as today.

### Refund call

```json
{
  "order_id": "ord_5Kd9",
  "shipment_group_id": "sg_2",
  "lines": [{ "line_id": "l3", "quantity": 1 }],
  "reason": "returned",
  "approved_by": "rules",
  "idempotency_key": "rfd-ord_5Kd9-sg_2-1"
}
```

The refund follows [SPEC-050](@SPEC-050); the seller's payout is reduced by the refunded amount ([SPEC-057](@SPEC-057)).

## Alternatives

| Option | Why not |
| -- | -- |
| More support staff | Cost grows with orders; nights and weekends still wait |
| Refund before the return arrives | Abuse risk too high for most categories |
| **Rules with a confirmed return** | Under review |

## Rollout

- [X] Pilot under 50 EUR (June 2026)
- [ ] Up to 150 EUR, behind `refunds.self_service_150`
- [ ] Voucher refunds instantly for every amount
- [ ] Monthly abuse review with sellers

## Open questions

* Should sellers see automatic refunds before money moves? Reviewers disagree; a 2-hour veto window is one option.
* Who pays when an automatic refund is later disputed and the seller wins? Proposed: DemoMart, up to 0.5 % of refunded value.

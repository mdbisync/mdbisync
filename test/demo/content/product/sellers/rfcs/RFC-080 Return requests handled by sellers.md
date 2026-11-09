| Status | Draft |
| -- | -- |
| Created | 2026-07-07 |
| Authors | DemoErin |
| Reviewers | DemoLaura, DemoMike |
| Target | Q1 2027 |
| Evidence | [RN-076 Return reasons by category](@RN-076) |

## Summary

Send buyers' return requests straight to the seller in Seller Hub, let the seller approve, refuse with a reason, or offer a partial refund, and escalate to DemoMart support only when the two sides do not agree within 3 days.

## Motivation

Every return request today goes to DemoMart support first. Support approves 93 % of them unchanged, and then forwards them to the seller by message. A return takes a median of 9.4 days from request to refund, and support spends about 5,200 hours a quarter on requests it barely touches. For fashion, where 18.4 % of orders are returned ([RN-076](@RN-076)), sellers ask to handle "wrong size" returns themselves and to offer an exchange.

## Proposal

@@picture:rfc-080-returns@@

### The flow

The full state machine is [SPEC-084](@SPEC-084). In short:

1. The buyer requests a return with a reason and optional photos.
2. The seller has 2 business days to approve, refuse with a reason, or offer a partial refund to keep the item.
3. No answer in 2 days: the request is approved automatically.
4. If the buyer does not accept a refusal or an offer, the case goes to DemoMart support, which decides within 3 days.
5. On approval, the buyer gets a prepaid return label ([SPEC-083](@SPEC-083)); the refund ([SPEC-050](@SPEC-050)) is issued when the parcel is scanned by the carrier, not when it arrives.

### Rules sellers cannot change

* Items reported "damaged" or "not as described" with photos cannot be refused by the seller; only support can.
* A seller cannot charge a restocking fee above 10 % of the item price.

### API for seller systems

```graphql
mutation Respond($input: RespondToReturnInput!) {
  respondToReturn(input: $input) {
    returnRequest { id state deadline }
  }
}
```

```json
{
  "input": {
    "returnRequestId": "ret_20931",
    "decision": "PARTIAL_REFUND",
    "refund": { "amount": 1200, "currency": "EUR" },
    "message": "We can refund 12 EUR if you keep the lamp."
  }
}
```

## Alternatives

| Option | Median time to refund (estimate) | Support hours per quarter | Why not |
| -- | -- | -- | -- |
| Support handles all returns (today) | 9.4 days | 5,200 | Slow and costly |
| Approve every return automatically | 4.1 days | 900 | Sellers lose all say; abuse risk |
| **Sellers decide, support escalates** | **5.0 days** | **1,600** | Proposed |

## Rollout

- [ ] Agree the rules sellers cannot change with the trust team
- [ ] Return labels in [RFC-078](@RFC-078)'s label service
- [ ] Pilot in fashion with sellers who opt in
- [ ] Measure time to refund and escalation rate for 8 weeks

## Open questions

* Exchanges: do we model an exchange as a return plus a new order, or as its own flow? Draft answer: return plus a new order with a 100 % voucher ([SPEC-053](@SPEC-053)), so no new payment logic is needed.
* Does a refusal count against the seller in [SPEC-082](@SPEC-082)? Only when support overturns it.

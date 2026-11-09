| Status | Implemented |
| -- | -- |
| Created | 2025-07-08 |
| Authors | DemoFrank |
| Reviewers | DemoIvan, DemoErin |
| Target | Q4 2025 |
| Decision | [ADR-021 Keep the order state machine in orders-svc](@ADR-021) |

## Summary

A cart with items from several sellers becomes one order with one payment and one shipment group per seller. Each seller ships, cancels and refunds their own group; the buyer sees one order with several parcels.

## Motivation

Today a cart may hold items from one seller only. Buyers who add a second seller's item are told to check out twice: 17 % of them abandon the second cart, and 6 % of support contacts in June were about it. 38 % of searches that end in an add to cart are for items in a different shop from the cart's current one.

## Proposal

@@picture:rfc-046-split@@

### Data model

An order gets `shipment_groups`, one per seller. Each group has its own state ([SPEC-047](@SPEC-047)) and its own shipping option and cost ([SPEC-051](@SPEC-051)); the order's state is derived from its groups.

```json
{
  "order_id": "ord_5Kd9",
  "payment_intent_id": "pi_88Qe",
  "total": { "amount": 6480, "currency": "EUR" },
  "shipment_groups": [
    { "id": "sg_1", "seller_id": "sel_A", "items": 2, "shipping": { "amount": 495, "currency": "EUR" }, "state": "shipped" },
    { "id": "sg_2", "seller_id": "sel_B", "items": 1, "shipping": { "amount": 0, "currency": "EUR" }, "state": "accepted" },
    { "id": "sg_3", "seller_id": "sel_C", "items": 2, "shipping": { "amount": 390, "currency": "EUR" }, "state": "pending_acceptance" }
  ]
}
```

### Payment

One payment intent for the whole order ([SPEC-048](@SPEC-048)), captured per group when that group ships. A cancelled group releases its part of the authorisation; a group refunded after capture is refunded on its own ([SPEC-050](@SPEC-050)).

### Payouts

Each group pays out to its seller ([SPEC-057](@SPEC-057)). Shipping is the seller's revenue; our commission applies to items only.

## Alternatives

| Option | Buyer experience | Why not |
| -- | -- | -- |
| Separate orders per seller, one checkout | Several confirmations, several payments | Buyers saw several charges and called their bank |
| DemoMart consolidates parcels in a warehouse | One parcel | We hold no stock; a warehouse is a different business |
| **One order, groups per seller** | **One payment, several parcels** | Chosen |

## Rollout

- [X] Groups in `orders-svc`, one group per order for existing flows
- [X] Partial capture and partial release in `demo-pay`
- [X] Carts with up to 5 sellers, behind `checkout.multi_seller`
- [X] All buyers

## Open questions

* Free shipping thresholds are per seller today. A marketplace-wide threshold needs a funding model and is out of scope.

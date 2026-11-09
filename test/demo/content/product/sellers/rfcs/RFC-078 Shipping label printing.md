| Status | Implemented |
| -- | -- |
| Created | 2026-05-04 |
| Authors | DemoMike |
| Reviewers | DemoKen, DemoLaura |
| Target | Q3 2026 |
| Evidence | [RN-075 Late shipments by carrier](@RN-075) |

## Summary

Let sellers buy and print a shipping label for an order inside Seller Hub, with the carrier's cut-off time shown before they print, and attach the tracking number to the order automatically.

## Motivation

41 % of late shipments in Q1 2026 had a label created after the carrier's daily cut-off ([RN-075](@RN-075)). Sellers create labels on carrier websites, copy tracking numbers into Seller Hub by hand, and 6 % of those numbers had a typo or belonged to another order. A shipment without valid tracking counts against the seller's performance ([SPEC-082](@SPEC-082)) even when the parcel arrives on time.

## Proposal

@@picture:rfc-078-labels@@

### In Seller Hub

* On an order, **Buy label** shows the carriers that serve the route, with price, delivery estimate and today's cut-off.
* After the cut-off, Seller Hub says plainly that the parcel leaves tomorrow and offers the next carrier with a later cut-off, if there is one.
* Labels print as PDF, A6 or A4 with four labels, and as ZPL for thermal printers.
* For a batch of orders, labels are bought together and merged into one PDF.

### The API

Seller Hub and partner apps use the same call ([SPEC-083](@SPEC-083)):

```graphql
mutation BuyLabel($input: CreateShippingLabelInput!) {
  createShippingLabel(input: $input) {
    label { id carrier trackingNumber format downloadUrl }
    handover { cutoffAt nextCollectionAt }
  }
}
```

The tracking number is written to the order by `fulfilment-svc`, which publishes `shipment.label_created` ([order events](@SPEC-017)). The buyer gets the tracking link through [notify-svc](@ADR-039).

### Paying for labels

Label costs are deducted from the next payout ([SPEC-081](@SPEC-081)) and shown as their own line in the payout statement. Amounts are integer minor units ([ADR-020](@ADR-020)).

## Alternatives

| Option | Fixes late labels | Fixes tracking typos | Why not |
| -- | -- | -- | -- |
| Show cut-off times only | partly | no | Sellers still copy numbers by hand |
| Import tracking numbers from carrier accounts | no | yes | Needs every seller to connect a carrier account |
| **Labels in Seller Hub** | **yes** | **yes** | Chosen |

## Rollout

- [X] Three carriers connected in the sandbox
- [X] Batch printing for up to 100 orders
- [X] Open to all sellers in two countries, 2026-08-04
- [X] Tracking typos on Seller Hub labels: none in August
- [ ] Two more carriers
- [ ] Return labels, for [RFC-080](@RFC-080)

## Open questions

* Do we offer label insurance? Carriers include it up to a value; above that, it is a separate product we have not designed.

| Status | Complete |
| -- | -- |
| Date | 2026-04-14 |
| Authors | DemoMike, DemoJudy |
| Led to | [RFC-078 Shipping label printing](@RFC-078) |

## Question

Why are orders handed to carriers late, and is it the carriers or the way sellers create labels?

## Method

* All 2.3 million shipments of Q4 2025 and Q1 2026 with a promised dispatch date. A shipment is late when the carrier's first scan comes after the promised dispatch date ([SPEC-082](@SPEC-082)).
* Five carriers, named here Carrier A to Carrier E.
* For a random sample of 2,000 late shipments in Q1 2026, we matched the label creation time, the carrier's cut-off and the first scan to find the cause.
* Tracking numbers entered by hand were checked against the carrier's records.

## Results

@@picture:rn-075-late-by-carrier@@

@@table:rn-075-late-by-carrier@@

@@csv:rn-075-late-by-carrier@@

@@picture:rn-075-causes@@

@@table:rn-075-causes@@

## Findings

* Late rates differ by carrier, from 2.7 % for Carrier C to 6.8 % for Carrier D in Q1 2026, but every carrier improved or stayed flat except Carrier D.
* The largest cause is ours to fix: 41 % of late shipments had their label created after the carrier's cut-off. The seller believed the parcel would leave the same day.
* Carrier delays proper are 33 % of late shipments. Address problems are 14 % and parcels dropped at a depot that does not serve the route 12 %.
* 6 % of tracking numbers typed in by sellers did not match the carrier's records, or belonged to another order. Those shipments count as "no valid tracking" even when they arrive on time.
* Sellers who create more than 20 labels a day are late less often (2.9 %) than those with fewer than 5 a day (5.6 %); the large sellers know the cut-offs.

## Recommendation

Create labels in Seller Hub, show each carrier's cut-off before the seller buys, and attach the tracking number to the order automatically. Proposed in [RFC-078](@RFC-078); the API is [SPEC-083](@SPEC-083).

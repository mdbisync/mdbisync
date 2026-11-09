| Status | Complete |
| -- | -- |
| Date | 2026-04-14 |
| Authors | DemoKen, DemoHeidi |
| Led to | Rule changes in [SPEC-056 Fraud checks](@SPEC-056), version 2.0 |

## Question

How many orders held for manual fraud review are legitimate, which rules send them there, and what happened after we changed the two worst rules in March 2026?

## Method

* All orders held for review from November 2025 to March 2026: 41,800 orders.
* "Legitimate" means the reviewer released the order and no chargeback followed within 90 days.
* On 2 March 2026 the country mismatch rule was limited to mismatches outside the EU, and the new account rule moved from 300 EUR to 600 EUR with a device score check ([SPEC-056](@SPEC-056)).

## Results

@@picture:rn-049-rules@@

@@table:rn-049-rules@@

@@csv:rn-049-rules@@

@@picture:rn-049-review-rate@@

@@picture:rn-049-legitimate@@

@@table:rn-049-legitimate@@

## Findings

* Before the change about 71 % of reviewed orders were legitimate. Each review holds an order for a median of 3.4 hours, and 9 % of held buyers cancel.
* The country mismatch rule alone caused 38.6 % of false positives: buyers sending gifts within the EU.
* After the change the review rate fell from 0.85 % to 0.61 % of orders, and the legitimate share from 69.5 % to 52.4 %.
* Chargebacks did not rise: 0.07 % of order value in March against 0.08 % in February.

## Recommendation

Keep the new rules. Next, replace the parcel locker rule with the device score: lockers are a normal delivery choice in PL and NL.

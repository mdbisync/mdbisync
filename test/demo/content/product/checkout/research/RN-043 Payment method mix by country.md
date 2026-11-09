| Status | Complete |
| -- | -- |
| Date | 2025-09-02 |
| Authors | DemoHeidi |
| Led to | [RFC-048 Buy now, pay later as a payment method](@RFC-048), [SPEC-049 Payment method types](@SPEC-049) |

## Question

Which payment methods do buyers use in each of our five largest markets, and which method would win the most orders if we added it?

## Method

* All paid orders from 1 April to 30 June 2025: 1.9 million orders from the five markets with the most orders.
* Method as recorded on the payment intent ([SPEC-048](@SPEC-048)); a saved card counts separately from a card typed in.
* Market is the delivery country, not the buyer's account country.

## Results

@@picture:rn-043-mix@@

@@table:rn-043-mix@@

@@csv:rn-043-mix@@

## Findings

* **Bank transfer leads in NL (61 %) and PL (41 %).** These buyers use instant bank payments through their bank's app; checkout hands them over and back.
* **Cards lead in FR and ES**, and a third of card payments there use a saved card ([RFC-044](@RFC-044)).
* **Mobile wallets are steady at 8 to 14 %** in every market.
* Buy-now-pay-later was asked for in 1.4 % of support contacts about payment, mostly in DE. We have no order data for it because we do not offer it.

## Recommendation

* Keep the method order on the payment step per market: bank transfer first in NL and PL, card first elsewhere.
* Evaluate buy-now-pay-later for DE only, with a cost check against its fee ([RFC-048](@RFC-048)).

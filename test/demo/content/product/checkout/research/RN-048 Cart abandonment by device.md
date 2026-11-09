| Status | Complete |
| -- | -- |
| Date | 2025-12-09 |
| Authors | DemoJudy, DemoFrank |
| Led to | [RFC-065 Offline cart in the app](@RFC-065), cart reminders in [SPEC-046](@SPEC-046) |

## Question

How many carts are abandoned on each kind of device, and do reminders bring buyers back?

## Method

* Carts with at least one item created in November 2025: 1.31 million carts.
* A cart is abandoned when no order contains its items within 7 days.
* Device comes from the session that created the cart; a cart moved to another device counts for the first one.
* Reminders: for one week, half of abandoned carts of signed-in buyers who allow notifications got one reminder 20 hours after the last change, by push in the app or by email from the web.

## Results

@@picture:rn-048-abandonment@@

@@table:rn-048-abandonment@@

@@csv:rn-048-abandonment@@

@@picture:rn-048-return@@

@@table:rn-048-return@@

## Findings

* Phone browsers abandon most: 78.4 % of carts. Many phone carts are "save for later": 41 % of them are reopened on a desktop within 3 days, where the cart counts as already abandoned.
* The app abandons least (58.3 %); app carts stay in the app and are easy to come back to.
* One reminder after 20 hours raised late conversion from 6.5 % to 11.0 % within 7 days (95 % interval 4.0 to 5.0 points). A second reminder in a pilot added only 0.6 points and doubled unsubscribes.
* Carts with an item that sold out in the meantime convert at 2.1 %; the reminder should not be sent when the main item is out of stock.

## Recommendation

* Send one reminder 20 hours after the last cart change, never a second, and skip it when the cart's most expensive item is out of stock.
* Keep the cart across devices for signed-in buyers; it is already stored by buyer id ([SPEC-046](@SPEC-046)).

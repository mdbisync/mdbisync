| Status | Complete |
| -- | -- |
| Date | 2025-10-28 |
| Authors | DemoFrank |
| Led to | Keeping [RFC-047 Address autocomplete](@RFC-047) on for all markets |

## Question

Did address autocomplete ([RFC-047](@RFC-047)) reduce deliveries that fail because the address is wrong, and did it make the address step faster?

## Method

* Failed deliveries come from the carriers' status events with reason "address not found" or "recipient unknown at address", joined to the order.
* Seven weeks before and seven weeks after the launch on 25 August 2025 (week 0), 2.8 million delivered parcels.
* Address form errors come from the checkout's validation events.
* Other changes in the period: none to address handling. One carrier changed its reason codes in week 4; we mapped them back.

## Results

@@picture:rn-046-failed-deliveries@@

@@table:rn-046-failed-deliveries@@

@@csv:rn-046-failed-deliveries@@

@@picture:rn-046-errors@@

@@table:rn-046-errors@@

## Findings

* Wrong-address failures fell by 43 % on the web (from 9.9 to 5.6 per 1,000) and by 47 % on the app (from 11.8 to 6.2).
* Each failed delivery costs on average 7.40 EUR in return shipping and a second attempt. At our volume the drop saves about 18,000 EUR a month.
* Forms with a validation error fell from about a third to about an eighth. The median time on the address step fell from 74 to 41 seconds on the web.
* 82 % of buyers picked a suggestion; the rest typed the address in full, mostly for new buildings the address provider did not know yet.

## Recommendation

Keep autocomplete on everywhere. Report addresses that buyers typed in full and that then delivered successfully to the address provider each month, so new buildings appear sooner.

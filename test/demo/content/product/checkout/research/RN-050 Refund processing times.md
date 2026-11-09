| Status | Complete |
| -- | -- |
| Date | 2026-07-28 |
| Authors | DemoHeidi |
| Led to | [RFC-053 Self-service refunds](@RFC-053) |

## Question

How long does a buyer wait for money after asking for a refund, where does the time go, and how much would self-service refunds of [RFC-053](@RFC-053) save?

## Method

* All refunds requested in May and June 2026: 38,900 refunds.
* Stages: request to approval (support or seller), approval to refund sent to the payment method ([SPEC-050](@SPEC-050)), and refund sent to money returned, as reported by the payment method.
* "With self-service" is a pilot from 1 June for orders under 50 EUR whose seller had confirmed the return: 6,200 refunds approved automatically.

## Results

@@picture:rn-050-times@@

@@table:rn-050-times@@

@@csv:rn-050-times@@

@@picture:rn-050-steps@@

@@table:rn-050-steps@@

## Findings

* Before the pilot, the longest stage was waiting for approval: a median of 52 hours, mostly waiting for a support agent.
* Self-service removes that wait and most of the queue to send the refund. Card refunds now take 3.2 days instead of 6.8, and almost all of that is the card network.
* Bank transfer refunds stay slowest because the buyer's account details have to be confirmed for 31 % of them.
* Refund abuse in the pilot: 0.3 % of automatic refunds were later disputed by sellers, against 0.2 % of manual ones.

## Recommendation

Extend self-service refunds to orders up to 150 EUR with a confirmed return, and pay voucher refunds instantly for every amount.

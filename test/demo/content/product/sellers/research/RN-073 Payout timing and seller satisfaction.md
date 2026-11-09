| Status | Complete |
| -- | -- |
| Date | 2026-03-05 |
| Authors | DemoPeggy, DemoJudy |
| Led to | [RFC-077 Faster seller payouts](@RFC-077), then [SPEC-081 Payout schedule](@SPEC-081) version 2.0 |

## Question

How satisfied are sellers with the weekly payout schedule, which sellers want it to change, and how often would they like to be paid?

## Method

* An in-app survey in Seller Hub, 2026-02-09 to 2026-02-23, shown once to every seller with at least one payout in 2025. 1,240 sellers answered (a 17 % response rate).
* Questions: a rating of payouts from 1 (very poor) to 5 (very good), the preferred payout frequency, and an open comment.
* Answers were grouped by the seller's monthly sales over the previous six months, in EUR.
* Survey answers were joined with each seller's payout history; no answer is shown here for a group of fewer than 50 sellers.

## Results

@@picture:rn-073-satisfaction@@

@@table:rn-073-satisfaction@@

@@csv:rn-073-satisfaction@@

@@picture:rn-073-frequency@@

@@table:rn-073-frequency@@

## Findings

* Small sellers are the least satisfied: 48 % of sellers under 1,000 EUR a month rate payouts good or very good, against 71 % above 50,000 EUR.
* Asked how often they want to be paid, 34 % chose daily, 29 % twice a week and 31 % weekly. Only 6 % chose monthly.
* Among small sellers, the wish for daily payouts is stronger: 46 % of them chose daily.
* The open comments name the wait, not the amount: 212 comments mention "waiting" or "too long", 19 mention fees.
* Sellers whose last payout was delayed by a bank holiday rated payouts 0.6 points lower on average.

## Recommendation

Shorten the wait without daily transfers, whose fees and weaker refund cover are weighed in [RFC-077](@RFC-077). Twice-weekly runs answer the daily and twice-weekly groups (63 % together) better than today. Adopted in [SPEC-081](@SPEC-081) version 2.0.

| Status | Complete |
| -- | -- |
| Date | 2025-08-19 |
| Authors | DemoKen |
| Led to | Exemption rules in [RFC-049 3-D Secure 2 for card payments](@RFC-049) |

## Question

How often do card issuers challenge our buyers under 3-D Secure 2, how many buyers give up during a challenge, and how much do exemptions help?

## Method

* All card payments in July 2025 after the 3-D Secure 2 rollout: 642,000 payments.
* For two weeks, half of eligible payments asked the issuer for an exemption (low value under 30 EUR, or transaction risk analysis from the card acquirer), half did not.
* A challenge counts as completed when the buyer returns with a successful authentication result.

## Results

@@picture:rn-045-challenge@@

@@table:rn-045-challenge@@

@@picture:rn-045-completion@@

@@table:rn-045-completion@@

@@csv:rn-045-challenge@@

## Findings

* Without exemptions issuers challenged 33 to 45 % of payments. Asking for exemptions cut that to 18 to 27 %; issuers granted 61 % of exemption requests.
* Completion depends on the challenge type: buyers finish 91.4 % of banking app pushes but only 71.6 % of password pages.
* Each avoided challenge saves on average 0.21 orders that would have been lost, or about 4,100 orders a month.
* Exempted payments carry the fraud liability back to us. Fraud on exempted payments was 0.04 % of their value, below the 0.13 % threshold that would make the exemption unavailable.

## Recommendation

Request low-value and transaction-risk exemptions on every eligible payment, and watch the fraud rate of exempted payments monthly ([SPEC-056](@SPEC-056)).

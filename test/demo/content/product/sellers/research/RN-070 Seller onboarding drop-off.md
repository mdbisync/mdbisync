| Status | Complete |
| -- | -- |
| Date | 2026-02-10 |
| Authors | DemoLaura, DemoJudy |
| Led to | [RFC-079 Seller onboarding in one session](@RFC-079) |

## Question

Where do new sellers give up between starting sign-up and their first sale, and how long does each step take them?

## Method

* All 4,000 seller sign-ups started between 2025-10-01 and 2025-12-31, followed for 30 days each.
* Steps from the onboarding events: account created, business details, identity check passed, bank account added, first listing published, first sale.
* Time per step: from the step's first page view to its completion, median over sellers who completed it. Waiting time for the identity check is included.
* 12 short calls with sellers who stopped at the identity check, to hear why.

## Results

@@picture:rn-070-funnel@@

@@table:rn-070-funnel@@

@@csv:rn-070-funnel@@

@@picture:rn-070-step-time@@

@@table:rn-070-step-time@@

## Findings

* The identity check loses the most sellers: 18 of every 100 who start, the largest single drop.
* It is also the slowest step, a median of 31 minutes, almost all of it waiting on a page with nothing to do. In the calls, 9 of 12 sellers said they closed the tab "to come back later" and did not.
* Bank details lose another 11 points. Sellers asked why they need to give bank details before they have sold anything.
* Of sellers who publish a first listing, 59 % make a sale within 30 days. The listing, not the sale, is where onboarding should end.
* Sellers who published their first listing on the day they signed up were twice as likely to sell within 30 days as those who came back on a later day.

## Recommendation

Make the identity check run in the background and let sellers work on a first listing meanwhile; ask for bank details before the first payout instead of before the first listing. Proposed in [RFC-079](@RFC-079). The account states needed for it are in [SPEC-078](@SPEC-078).

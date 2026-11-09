| Status | Complete |
| -- | -- |
| Date | 2025-07-22 |
| Authors | DemoErin |
| Led to | Guest checkout for all markets, [RFC-045](@RFC-045) |

## Question

How many more first-time buyers order when they can check out without creating an account, and how many of them create an account later anyway?

## Method

* A/B test from 16 June 2025, 21 days, among buyers without an account who opened checkout: 118,900 sessions.
* Control asked for sign-in or sign-up before the address; the variant offered "Continue as guest" next to it ([RFC-045](@RFC-045)).
* Primary metric: orders per checkout session. Secondary: share of guest buyers who create an account within 30 days, followed up to 16 August.

## Results

@@picture:rn-047-conversion@@

@@table:rn-047-conversion@@

@@csv:rn-047-conversion@@

@@picture:rn-047-accounts@@

@@table:rn-047-accounts@@

## Findings

* Guest checkout raised first-time buyer conversion by 8.2 points on the web (95 % interval 7.4 to 9.0) and 5.4 points on the app (4.3 to 6.5).
* The app gains less because many app users are already signed in from the store's account prompt at install.
* 26.3 % of guest buyers created an account within 30 days, most of them from the order confirmation page, where the account needs only a password.
* Fraud review rates for guest orders were 1.1 % against 0.8 % for account orders; the fraud rules already score device and payment signals, not the account ([SPEC-056](@SPEC-056)).

## Recommendation

Offer guest checkout everywhere, and keep the one-click account offer on the confirmation page.

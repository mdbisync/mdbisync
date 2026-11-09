| Status | Complete |
| -- | -- |
| Date | 2025-02-11 |
| Authors | DemoErin, DemoJudy |
| Led to | [RFC-043 One-page checkout](@RFC-043), [RFC-045 Guest checkout](@RFC-045) |

## Question

Where do buyers leave checkout, and does the answer differ between the web shop and the app? We needed a baseline before redesigning the flow.

## Method

* Population: every session that opened the cart between 4 and 31 January 2025, 412,600 sessions (web 61 %, app 39 %).
* Steps come from the checkout analytics events ([SPEC-065](@SPEC-065) uses the same event conventions); a session counts for a step when the step's `viewed` event fires.
* Sessions that returned to the cart and finished later in the same session count once, at their furthest step.
* Bot traffic is excluded by the edge's bot score; 2.3 % of sessions were removed.

## Results

@@picture:rn-041-funnel@@

@@table:rn-041-funnel@@

Of 100 sessions that open the cart, 41.3 place an order. The largest single losses are at sign-in (21.6 points) and between address and payment (11.9 points across two steps).

@@picture:rn-041-step-loss@@

@@table:rn-041-step-loss@@

@@csv:rn-041-funnel@@

## Findings

* **Sign-in is the biggest leak.** 21.6 % of sessions leave when asked to sign in or create an account; on the app it is 24.1 %. Session recordings show buyers looking for a way to continue without an account.
* **The address step is slow.** Median time on the step is 74 seconds on the web and 96 seconds on the app; 31 % of address forms show at least one validation error.
* **Review loses buyers who already chose a payment method.** 15.6 % on the web. The review page is the first place the full total with shipping appears.
* Shipping option choice is quick and loses few sessions.

## Recommendation

1. Let buyers check out as guests ([RFC-045](@RFC-045)).
2. Merge address, shipping, payment and review into one page that shows the full total from the start ([RFC-043](@RFC-043)).
3. Add address autocomplete to cut form errors ([RFC-047](@RFC-047)).

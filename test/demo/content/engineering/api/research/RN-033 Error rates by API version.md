| Status | Complete |
| -- | -- |
| Date | 2026-04-07 |
| Authors | DemoJudy, DemoKen |
| Led to | [RFC-037 Deprecation policy for API versions](@RFC-037) |

## Question

Do partners make fewer mistakes on v2 than on v1, and which errors remain on v2? A clear difference would support retiring v1 early ([ADR-044](@ADR-044)).

## Method

* Gateway logs from November 2025, when v2 became generally available, to March 2026.
* Client error rate: share of requests answered with `4xx`, excluding `401` from expired tokens, which clients recover from by design.
* For v2, the `4xx` responses of March 2026 grouped by problem type ([SPEC-032](@SPEC-032)).

## Results

@@picture:rn-033-client-errors@@

@@table:rn-033-client-errors@@

@@picture:rn-033-problem-types@@

@@table:rn-033-problem-types@@

@@csv:rn-033-client-errors@@

## Findings

* **v1 stays at about 5 % client errors.** It does not improve, because the partners left on it are the ones not changing their code.
* **v2 falls from 1.9 % to 1.2 %** as partners fix their first integration mistakes. Problem details with a stable `type` let them see exactly what was wrong ([RFC-039](@RFC-039)).
* **Validation failures lead on v2** (38 %), mostly prices sent as decimal strings instead of minor units, a habit carried over from v1.
* **Rate limiting is 16 %** of v2 client errors (`rate-limited`), before the per-class limits of [RFC-033](@RFC-033) are enforced.
* **Invalid state transitions are 11 %** (`invalid-state-transition`), mostly confirming orders that had already been cancelled after 48 hours without confirmation.

## Recommendation

* Keep the v1 retirement date of 2026-06-30 ([RFC-037](@RFC-037)): v1 costs us and partners four times the error rate.
* Add a validation hint for decimal prices: the problem's `detail` names minor units.
* Point partners at the `confirm_by` deadline that `order.paid` webhooks carry since March 2026, so they stop confirming late ([SPEC-040](@SPEC-040)).

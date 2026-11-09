| Status | Complete |
| -- | -- |
| Date | 2026-01-20 |
| Authors | DemoHeidi, DemoKen |
| Led to | [RFC-050 Payment retries for soft declines](@RFC-050) |

## Question

How many card payments that fail with a soft decline would succeed if we retried them, and does the retry schedule matter?

## Method

* Soft declines are declines the card network marks as retryable. From October to December 2025 there were 61,300 of them, 3.2 % of card attempts.
* For four weeks, 20 % of soft-declined payments were retried by `demo-pay` without the buyer doing anything. Half used a fixed 30 second delay, half a schedule by reason code.
* Retries stop at four, or when the buyer leaves the payment page, or after 10 minutes in total.
* Success counts only the authorisation; captures and refunds are out of scope.

## Results

@@picture:rn-044-reasons@@

@@table:rn-044-reasons@@

@@picture:rn-044-recovery@@

@@table:rn-044-recovery@@

@@csv:rn-044-recovery@@

## Findings

* The reason-based schedule recovered 33.1 % of soft declines after four retries, against 21.4 % for the fixed delay. The difference is significant (95 % interval 9.8 to 13.6 points, 12,260 payments).
* "Issuer unavailable" recovers best with a short delay of 2 seconds; "insufficient funds" hardly recovers within 10 minutes and should not be retried more than once.
* "Authentication required" must not be retried at all: the buyer has to complete a 3-D Secure challenge ([RFC-049](@RFC-049)).
* Retries did not raise the fraud review rate (0.81 % against 0.83 %).

## Recommendation

Retry soft declines in `demo-pay` with a schedule per reason code, at most four times within 10 minutes, and never for authentication-required declines. Proposed in [RFC-050](@RFC-050). Expected gain: about 6,500 more paid orders a quarter.

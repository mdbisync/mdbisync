| Status | Complete |
| -- | -- |
| Date | 2025-05-27 |
| Authors | DemoErin, DemoJudy |
| Led to | Full rollout of [RFC-043 One-page checkout](@RFC-043) |

## Question

Does the one-page checkout of [RFC-043](@RFC-043) raise the share of checkout sessions that end in an order, without raising payment failures or fraud?

## Method

* A/B test behind the `checkout.one_page` feature flag ([ADR-022](@ADR-022)), 50/50 by buyer id, 28 days from 22 April 2025.
* 386,240 sessions that opened checkout: 193,410 control, 192,830 variant.
* Primary metric: orders per checkout session. Guardrails: payment failure rate, fraud review rate, average order value.
* Two-sided test at 95 %; the sample was sized to detect a 1.5 point change with 80 % power.

## Results

@@picture:rn-042-conversion@@

@@table:rn-042-conversion@@

Across platforms conversion rose from 41.2 % to 44.7 %, a lift of 3.5 points (95 % confidence interval 3.2 to 3.8 points). The lift holds on both platforms.

@@picture:rn-042-time@@

@@csv:rn-042-time@@

| Guardrail | Control | One-page | Change |
| -- | -- | -- | -- |
| Payment failure rate | 6.1 % | 6.0 % | no significant change |
| Sent to fraud review | 0.82 % | 0.84 % | no significant change |
| Average order value | 48.20 EUR | 47.90 EUR | no significant change |

## Findings

* The variant is faster: the median time from cart to order fell from 210 to 146 seconds, after a learning effect in the first three days.
* Most of the gain comes from buyers who used to leave at the review step; showing the total from the start removes the surprise.
* The app gains as much as the web, even though the app's page is long; buyers scroll.

> [!NOTE]
> The novelty effect was checked by comparing the first and second half of the test. The lift was 3.6 and 3.4 points.

## Recommendation

Roll the one-page checkout out to all buyers and remove the five-step flow after one release. Done on 3 June 2025.

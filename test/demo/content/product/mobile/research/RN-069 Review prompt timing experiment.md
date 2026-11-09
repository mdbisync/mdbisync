| Status | Complete |
| -- | -- |
| Date | 2026-09-08 |
| Authors | DemoLaura, DemoJudy |
| Led to | [RFC-073 In-app review prompts](@RFC-073) |

## Question

At which moment does the store review prompt most often lead to a rating, and does the moment change how good the rating is?

## Method

* Four arms of three weeks each, one trigger per arm, all app users eligible once per 120 days.
* The prompt is the system dialog of each platform. Neither store tells the app whether a rating was submitted, so we matched prompts to new ratings in the stores' daily reports by app version and hour.
* Share of ratings: submitted ratings divided by prompts shown. Average rating comes from the same matched ratings.

## Results

@@picture:rn-069-prompt-timing@@

@@table:rn-069-prompt-timing@@

@@csv:rn-069-prompt-timing@@

| Trigger | Average rating (iOS) | Average rating (Android) |
| -- | -- | -- |
| Third app open | 4.0 | 3.8 |
| After delivery confirmed | 4.5 | 4.4 |
| After a 5-star seller rating | 4.7 | 4.6 |
| After a refund | 2.9 | 2.7 |

## Findings

* The current trigger, the third app open, produces few ratings (4.2 % iOS, 5.1 % Android) with an average below the app's store rating.
* Prompts after a confirmed delivery or a 5-star seller rating lead to a rating three times as often, and those ratings average 4.4 to 4.7.
* After a refund, prompts rarely lead to a rating (2.1 % and 2.6 %), and those ratings average below 3. The prompt should never appear in the days after a problem.
* The matching of prompts to ratings is approximate. The differences between arms are far larger than the matching error, which we estimate at under 0.5 points.

## Recommendation

Prompt only after a confirmed delivery or a 5-star seller rating, never within 14 days of a refund, failed payment or support contact. Proposed in [RFC-073](@RFC-073).

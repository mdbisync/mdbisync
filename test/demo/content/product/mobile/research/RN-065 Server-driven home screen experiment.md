| Status | Complete |
| -- | -- |
| Date | 2026-04-02 |
| Authors | DemoLaura, DemoJudy |
| Led to | [RFC-068 A server-driven home screen](@RFC-068) |

## Question

Does the server-driven home screen do at least as well as the fixed layout, so that we can switch everyone to it and change the home screen without releases?

## Method

* An A/B experiment in app 5.5, 14 days, 50 % of app users in each arm, assigned by buyer id through feature flags ([ADR-022](@ADR-022)).
* The server-driven arm got the layout from `home-svc` ([SPEC-072](@SPEC-072)); from day 4 the team moved "Recently viewed" up and added a personal row, which the fixed layout cannot do without a release.
* Primary metric: sessions with at least one product view started from the home screen. Guardrails: cold start time and orders per session.

## Results

@@picture:rn-065-conversion@@

@@table:rn-065-conversion@@

@@csv:rn-065-conversion@@

| Guardrail | Fixed layout | Server-driven | Change |
| -- | -- | -- | -- |
| Median cold start, low-end Android | 3,380 ms | 3,010 ms | −11 % |
| Orders per 100 sessions | 4.12 | 4.31 | +4.6 % |
| Home screen errors per 10,000 sessions | 3.1 | 2.4 | −23 % |

## Findings

* For the first three days both arms were equal (38.1 % against 37.9 %), as expected with the same layout.
* After the layout changes on day 4, the server-driven arm rose to about 41 to 42 % of sessions with a product view from the home screen, while the fixed layout stayed near 38 %. Over days 8 to 14 the difference is 3.9 points (95 % interval 3.1 to 4.7).
* Cold start got faster, not slower: the app shows the cached layout and refreshes it in the background ([RFC-067](@RFC-067)).
* Orders per session rose by 4.6 %; the experiment was not sized for that metric, so we treat it as a guardrail that held.

## Recommendation

Switch all app users to the server-driven home screen and remove the fixed layout from the next release. Done as part of [RFC-068](@RFC-068).

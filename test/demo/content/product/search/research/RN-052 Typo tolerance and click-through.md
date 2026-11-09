| Status | Complete |
| -- | -- |
| Date | 2025-09-26 |
| Authors | DemoNina |
| Led to | [RFC-055 Typo tolerance in product search](@RFC-055), rollout to 100 % |

## Question

Does the fuzzy matching proposed in [RFC-055](@RFC-055) bring buyers to products they click, or does it only replace empty pages with irrelevant ones?

## Method

* A/B test on the web shop and the app, 14 days from 2025-09-08, 50 % of sessions in each arm, assigned by session id.
* Control: exact term matching after stemming. Treatment: fuzzy matching with edit distance 1 for terms of 4 to 7 characters and 2 for longer terms, no fuzziness on the first character, exact matches boosted ([SPEC-059](@SPEC-059)).
* 2.3 million searches in control, 2.3 million in treatment. Primary metric: share of searches followed by a product click within 60 seconds. Guardrail: NDCG@10 on the frozen baseline set ([RN-051](@RN-051)).

## Results

@@picture:rn-052-ctr@@

@@table:rn-052-ctr@@

@@csv:rn-052-ctr@@

| Measure | Control | Treatment | Change |
| -- | -- | -- | -- |
| Zero-result rate, all searches | 3.6 % | 1.9 % | −1.7 points |
| Zero-result rate, tail | 14.2 % | 7.1 % | −7.1 points |
| NDCG@10, head (guardrail) | 0.71 | 0.71 | none |
| NDCG@10, tail | 0.38 | 0.44 | +0.06 |
| p99 query latency | 142 ms | 151 ms | +9 ms |

## Findings

* Click-through rose most where it was lowest: tail queries from 27 % to 33 %, a relative gain of 22 %. The change is significant at p < 0.001 (two-proportion z-test).
* Head queries did not move. Exact-match boosting keeps "desk" from matching "disk" listings ahead of real desks.
* Short terms remain a weak spot. For three-letter terms we kept fuzziness off: in a sample, "mug" matched "rug" and "bag" matched "bog" more often than it helped.
* Latency cost was 9 ms at p99, inside the 200 ms budget of [SPEC-059](@SPEC-059).

## Recommendation

Roll the treatment out to all traffic. Keep fuzziness off for terms under four characters, and handle known misspellings of short words with synonyms ([SPEC-063](@SPEC-063)).

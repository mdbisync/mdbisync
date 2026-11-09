| Status | Complete |
| -- | -- |
| Date | 2025-12-19 |
| Authors | DemoHeidi |
| Led to | [RFC-057 Learning to rank for search results](@RFC-057), rollout to 100 % |

## Question

Does the 48-feature LambdaMART model chosen in [RN-053](@RN-053) raise purchases from search, not only NDCG on judged queries?

## Method

* A/B test, 28 days from 2025-11-17, covering the November sales week. 50 % of sessions per arm; 9.6 million searches in total.
* Control: BM25 with hand-tuned boosts. Treatment: the same retrieval, top 200 re-ranked by the model ([SPEC-061](@SPEC-061)).
* Primary metric: purchases attributed to search per 1,000 searches (last search before the order within the session). Secondary: click-through, mean reciprocal rank of the first click. Guardrails: p99 latency, zero-result rate.

## Results

@@picture:rn-054-purchases@@

@@table:rn-054-purchases@@

@@csv:rn-054-purchases@@

| Measure | Control | Treatment | Change |
| -- | -- | -- | -- |
| Purchases per 1,000 searches | 31.4 | 33.9 | +8.0 % |
| Searches followed by a click | 47.8 % | 50.6 % | +2.8 points |
| Mean reciprocal rank of first click | 0.412 | 0.447 | +0.035 |
| p99 latency | 158 ms | 170 ms | +12 ms |
| Zero-result rate | 1.9 % | 1.9 % | none |

## Findings

* Purchases per 1,000 searches rose by 8.0 % (95 % interval 5.1 % to 10.9 %). The lift held in each of the four weeks, including the sales week, when the model had to rank many discounted products it had little history for.
* The lift is largest on torso queries, matching the offline result.
* A cold-start effect remains: products listed in the last 7 days got 18 % fewer impressions in treatment. The model leans on 28-day conversion rate, which new listings do not have yet.

> [!IMPORTANT]
> New listings need a boost before full rollout, or sellers will see new products disappear from search. The rollout plan in [RFC-057](@RFC-057) adds an exploration slot for listings younger than 14 days.

## Recommendation

Roll out with the new-listing exploration slot, then repeat the cold-start measurement after four weeks.

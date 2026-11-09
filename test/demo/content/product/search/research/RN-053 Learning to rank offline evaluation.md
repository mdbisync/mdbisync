| Status | Complete |
| -- | -- |
| Date | 2025-11-14 |
| Authors | DemoHeidi, DemoOscar |
| Led to | [RN-054 Learning to rank online experiment](@RN-054) |

## Question

Which ranking model should go into the online experiment of [RFC-057](@RFC-057), and how many features does it need to beat hand-tuned boosts?

## Method

* **Training data:** 410,000 queries from 12 weeks of logs, with click-derived labels (a purchase counts 3, add to cart 2, a click with dwell over 20 seconds 1), debiased for position with inverse propensity weights estimated from a two-week result-randomisation slice.
* **Evaluation:** NDCG@10 on the frozen baseline set of [RN-051](@RN-051) (human grades, not clicks), so models are not judged by the labels they learned from.
* **Candidates:** BM25 with today's boosts and the typo tolerance of [RN-052](@RN-052); BM25 with hand-tuned boosts for price, rating and stock; LambdaMART with the 48 core features of [SPEC-061](@SPEC-061); LambdaMART with all 117 features.
* **Latency:** re-ranking the top 200 results on a production-sized search node, measured as added p99 time per query.

## Results

@@picture:rn-053-ndcg@@

@@table:rn-053-ndcg@@

@@picture:rn-053-latency@@

@@csv:rn-053-ndcg@@

## Findings

* Learned ranking beats hand tuning in every class. The largest gain is in the torso, from 0.57 to 0.65, which is where [RN-051](@RN-051) found relevant products sitting too low.
* The step from 48 to 117 features adds 0.01 overall and 0.02 in the tail, but doubles the added latency (11 ms to 24 ms) and needs 31 more features computed at index time.
* The most important features by gain: BM25 on title, 28-day conversion rate of the product, query-category match, and price relative to the category median. Together they hold 54 % of total gain.

## Recommendation

Take LambdaMART with the 48 core features into the online experiment. Revisit the full set once the feature store described in [SPEC-061](@SPEC-061) computes the extra features cheaply.

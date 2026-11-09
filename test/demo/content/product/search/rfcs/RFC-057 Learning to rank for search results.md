| Status | Implemented |
| -- | -- |
| Created | 2025-10-06 |
| Authors | DemoHeidi |
| Reviewers | DemoNina, DemoOscar, DemoKen |
| Target | Q1 2026 |
| Decision | Within [ADR-012 Use OpenSearch for product search](@ADR-012); model and features in [SPEC-061](@SPEC-061) |

## Summary

Re-rank the top 200 results of every product search with a gradient-boosted LambdaMART model trained on debiased clicks, carts and purchases, served by OpenSearch's learning-to-rank plugin.

## Motivation

On torso queries, relevant products exist but sit at positions 6 to 20 ([RN-051](@RN-051)); NDCG@10 there is 0.55. Hand-tuned boosts for price, rating and stock moved it to 0.57 and then stopped helping: every new boost that helped one category hurt another. The signals that matter interact (a cheap product is good for "desk" and bad for "solid oak desk"), which a learned model handles and fixed weights do not.

## Proposal

@@picture:rfc-057-ranking@@

### Two-stage ranking

1. **Retrieve** the top 200 by BM25 with typo tolerance ([RFC-055](@RFC-055)), as today.
2. **Re-rank** them with the model using `rescore` with a window of 200. Positions beyond 200 keep BM25 order.

```json
{
  "query": { "multi_match": { "query": "standing desk", "fields": ["title^4", "brand^3", "category_path^2", "description"] } },
  "rescore": {
    "window_size": 200,
    "query": {
      "rescore_query": {
        "sltr": { "params": { "keywords": "standing desk", "buyer_country": "DE" }, "model": "ltr-2025-12-v3" }
      },
      "query_weight": 0,
      "rescore_query_weight": 1
    }
  }
}
```

### Features and training

* 48 core features in four groups: text match, product quality, commercial, and query context ([SPEC-061](@SPEC-061)).
* Labels from 12 weeks of logs: purchase 3, add to cart 2, click with dwell over 20 seconds 1, skipped above a click 0; weighted by inverse propensity estimated from a result-randomisation slice of 0.5 % of traffic.
* Weekly retraining; a model ships only if NDCG@10 on the frozen judged set ([SPEC-067](@SPEC-067)) does not drop in any query class.

```python
params = {
    "objective": "lambdarank",
    "metric": "ndcg",
    "ndcg_eval_at": [10],
    "num_leaves": 63,
    "learning_rate": 0.05,
    "min_data_in_leaf": 200,
    "lambdarank_truncation_level": 20,
}
model = lgb.train(params, train_set, num_boost_round=600, valid_sets=[judged_set])
```

### Cold start

Listings younger than 14 days have no conversion history. One of the top 10 positions is reserved for the best-matching new listing when it scores within 15 % of position 10 ([RN-054](@RN-054)).

## Alternatives

| Option | Offline NDCG@10, traffic weighted | Added p99 | Why not |
| -- | -- | -- | -- |
| More hand-tuned boosts | 0.628 | 2 ms | Plateaued; boosts conflict across categories |
| **LambdaMART, 48 features** | **0.687** | **11 ms** | Chosen |
| LambdaMART, 117 features | 0.693 | 24 ms | Small gain, double latency ([RN-053](@RN-053)) |
| Neural re-ranker on text | not tested | about 60 ms | Over the latency budget of [SPEC-059](@SPEC-059) |

## Rollout

- [X] Feature logging in search-svc
- [X] Offline evaluation ([RN-053](@RN-053))
- [X] Online A/B test for 28 days ([RN-054](@RN-054)): +8.0 % purchases per 1,000 searches
- [X] New-listing exploration slot
- [X] Rollout to 100 % on 2026-01-12
- [ ] Repeat the cold-start measurement after four weeks

## Open questions

* Personalised features for signed-in buyers were proposed separately in [RFC-061](@RFC-061).

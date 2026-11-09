| Status | Stable |
| -- | -- |
| Version | 1.2 |
| Updated | 2026-01-12 |
| Owner | DemoHeidi |
| Applies to | The learning-to-rank feature set `core-48` and every model trained on it ([RFC-057](@RFC-057)) |

## Overview

The features the ranking model sees for each (query, listing) pair in the top 200. Features are defined once in the OpenSearch learning-to-rank feature store and logged by `search-svc` with each search, so training uses exactly the values that serving computed.

## Feature groups

| Group | Count | Examples | Computed |
| -- | -- | -- | -- |
| Text match | 16 | BM25 on title, brand, category path; exact title match; share of query terms matched | per query, in OpenSearch |
| Product quality | 11 | rating, review count (log), share of images over 1,000 px, listing completeness score ([SPEC-085](@SPEC-085)) | at index time |
| Commercial | 13 | price relative to category median, 28-day conversion rate, 28-day click-through, in stock, delivery days to the buyer's country | nightly or at index time |
| Query context | 8 | query length, predicted category match, query class (head, torso, tail), device type | per query, in search-svc |

## Top features by gain

| Rank | Feature | Group | Share of gain |
| -- | -- | -- | -- |
| 1 | `bm25_title` | Text match | 19 % |
| 2 | `conversion_28d` | Commercial | 15 % |
| 3 | `query_category_match` | Query context | 11 % |
| 4 | `price_vs_category_median` | Commercial | 9 % |
| 5 | `exact_title_phrase` | Text match | 6 % |
| 6 | `rating_bayesian` | Product quality | 5 % |

The first four hold 54 % of total gain ([RN-053](@RN-053)).

## Definitions

Each feature is a named template in the feature store. Two examples:

```json
{
  "featureset": {
    "name": "core-48",
    "features": [
      {
        "name": "bm25_title",
        "params": ["keywords"],
        "template": { "match": { "title": "{{keywords}}" } }
      },
      {
        "name": "price_vs_category_median",
        "params": [],
        "template": {
          "function_score": {
            "query": { "match_all": {} },
            "field_value_factor": { "field": "price_ratio_category_median", "missing": 1.0 }
          }
        }
      }
    ]
  }
}
```

Smoothed values avoid giving new listings extreme rates:

```python
def bayesian_rate(events: int, views: int, prior_rate: float, prior_weight: int = 200) -> float:
    """28-day rate shrunk towards the category's rate; prior_weight is in views."""
    return (events + prior_rate * prior_weight) / (views + prior_weight)
```

## Logging

`search-svc` logs the 48 values for every result in the top 200 of 5 % of searches, and for every result clicked in all searches, with the `query_id` of [SPEC-059](@SPEC-059). Logs go to ClickHouse ([ADR-011](@ADR-011)) and are kept 180 days.

## Rules for changing features

1. A new feature is added to a new feature set (`core-49`), never to an existing one.
2. It is logged for at least 4 weeks before a model may use it.
3. A model on the new set ships only if NDCG@10 on the judged set does not drop in any query class ([SPEC-067](@SPEC-067)).

## Version history

| Version | Date | Change |
| -- | -- | -- |
| 1.0 | 2025-10-20 | 117 candidate features logged |
| 1.1 | 2025-11-14 | `core-48` chosen from offline evaluation |
| 1.2 | 2026-01-12 | Bayesian smoothing for rates; in production |

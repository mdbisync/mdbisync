| Status | Accepted |
| -- | -- |
| Date | 2026-08-13 |
| Authors | DemoGrace |
| Reviewers | DemoIvan, DemoLaura |
| Plan | [RFC-059 Similar products with vector search](@RFC-059) |
| Evidence | [RN-057 Embedding models compared for similar products](@RN-057) |

## Context

The "similar products" row on product pages is built from co-purchase counts. It works for best sellers but returns nothing for 58 % of listings, which have too few sales, and new listings never appear in it. Buyers who click the row convert 2.3 times as often as those who do not, so empty rows cost sales.

## Decision

Similar products are found by **vector search over product embeddings**, stored in the existing OpenSearch cluster ([ADR-012](@ADR-012)) with its k-NN index.

* Embeddings combine title, category, attributes and the main image, from the model chosen in [RN-057](@RN-057); 384 dimensions.
* Vectors are computed when a listing is created or changed, by the pipeline of [SPEC-066](@SPEC-066).
* HNSW index with `m = 16`, `ef_search = 100`; results are filtered to in-stock listings and re-ranked with co-purchase signals where they exist.
* Target: p95 under 60 ms for 12 results.

```json
{
  "size": 12,
  "query": {
    "knn": {
      "embedding": { "vector": [0.021, -0.113, 0.087], "k": 50,
        "filter": { "term": { "in_stock": true } } }
    }
  }
}
```

## Options considered

| Option | Listings with a full row | Click-through on the row (offline estimate) | New components | Verdict |
| -- | -- | -- | -- | -- |
| **k-NN in OpenSearch** | **99 %** | **+31 %** | **none** | **Chosen** |
| Dedicated vector database | 99 % | +31 % | a new database | Same quality, one more system |
| Co-purchase only (today) | 42 % | baseline | none | The problem we have |

## Consequences

* Every listing gets a similar products row from day one.
* Index size grows by about 6.5 GB for 4.2 million vectors; the data nodes have room.
* Embedding model changes need a full re-index, about 9 hours.

## Follow-up

- [X] Embedding pipeline in production
- [ ] Similar products from vectors behind a flag at 10 %
- [ ] Online experiment before 100 %

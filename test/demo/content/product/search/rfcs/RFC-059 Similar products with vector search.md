| Status | Implemented |
| -- | -- |
| Created | 2026-06-08 |
| Authors | DemoHeidi |
| Reviewers | DemoNina, DemoKen, DemoCarol |
| Target | Q3 2026 |
| Decision | [ADR-045 Use vector search for similar products](@ADR-045) |

## Summary

Fill the "Similar products" row on every product page with nearest neighbours from an image and text embedding of each listing, stored as a k-NN vector field in the existing OpenSearch product index.

## Motivation

The row is built from co-purchases today. It is empty for 46 % of products, and for listings younger than 30 days it is empty in 91 % of cases. Product pages with a filled row have 12 % more add-to-cart events per view. [RN-057](@RN-057) showed that an open image and text model reaches precision@10 of 0.81 for acceptable substitutes.

## Proposal

@@picture:rfc-059-flow@@

### Embeddings

* Model: an open image and text model of the CLIP family, 512 dimensions, run on our CPU inference nodes. Listings without an image use the text tower only.
* Input text: title, brand, category path and the top five attributes. Input image: the main image at 224 pixels.
* Embeddings are computed when a listing changes, from the product events ([SPEC-018](@SPEC-018)), by the pipeline of [SPEC-066](@SPEC-066).

### Storage and query

A `knn_vector` field with an HNSW graph in the product index; no separate vector database ([ADR-045](@ADR-045)).

```json
{
  "size": 12,
  "query": {
    "knn": {
      "embedding": {
        "vector": [0.021, -0.113, 0.087],
        "k": 50,
        "filter": {
          "bool": {
            "filter": [
              { "term": { "in_stock": true } },
              { "term": { "top_category_id": "c-1000" } }
            ],
            "must_not": [{ "term": { "listing_id": "L-7712" } }]
          }
        }
      }
    }
  }
}
```

The vector in the example is shortened. Results are re-ordered by a light blend of similarity (0.8) and 28-day conversion rate (0.2), then deduplicated by seller so one seller cannot fill the row.

| Parameter | Value | Reason |
| -- | -- | -- |
| HNSW `m` | 16 | Recall@50 of 0.97 against exact search |
| `ef_construction` | 128 | Build time under 40 minutes for 3.1 million vectors |
| `ef_search` | 100 | p99 query time 18 ms |
| Memory per vector | about 2.3 KB | 7.1 GB for the catalogue, across 6 nodes |

## Alternatives

| Option | Coverage | Precision@10 | Why not |
| -- | -- | -- | -- |
| Co-purchases (today) | 54 % | 0.88 where present | Empty for new and niche products |
| **Embeddings in OpenSearch** | **99 %** | **0.81** | Chosen; co-purchases still lead where they exist |
| Separate vector database | 99 % | 0.81 | Another system to run and keep in step with the index |
| Same category, sorted by popularity | 100 % | 0.42 | Not similar enough |

## Rollout

- [X] Backfill embeddings for all listings (9 hours on 4 nodes)
- [X] Row shows co-purchases first, then embedding neighbours, behind a flag
- [X] A/B test on product pages: +9.4 % add-to-cart from the row
- [X] Rollout to 100 % on 2026-09-14

## Open questions

* Use the same vectors for "complete the look" (complementary products)? Not without a different training signal; similar is not complementary.

| Status | Stable |
| -- | -- |
| Version | 1.5 |
| Updated | 2026-09-14 |
| Owner | DemoOscar |
| Applies to | The OpenSearch index `products-v*` behind the alias `products` |

## Overview

One document per active listing, built by `search-svc` from the catalog change stream ([RFC-017](@RFC-017), [ADR-036](@ADR-036)) and the product events ([SPEC-018](@SPEC-018)). The index is rebuilt behind an alias for every incompatible mapping change; compatible additions are applied in place.

## Fields

| Field | Type | Searched | Filter or facet | Source |
| -- | -- | -- | -- | -- |
| `listing_id` | keyword | | yes | catalog |
| `title` | text, English analyser, boost 4 | yes | | catalog |
| `title.exact` | text, lowercase only | yes, exact clause | | catalog |
| `brand` | text and keyword, boost 3 | yes | facet | catalog |
| `category_path` | text, boost 2 | yes | | catalog |
| `category_ids` | keyword, all ancestors | | filter | catalog |
| `description` | text, boost 1 | yes, exact only | | catalog |
| `part_numbers` | keyword, lowercase | yes, exact | | catalog, added in 1.4 |
| `attributes.*` | keyword per attribute | | facet | catalog ([SPEC-079](@SPEC-079)) |
| `price_minor` | long | | filter, facet, sort | prices |
| `currency` | keyword | | filter | prices |
| `in_stock` | boolean | | filter | stock levels |
| `ships_to` | keyword, country codes | | filter | seller settings |
| `rating` | half_float | | filter, sort | reviews |
| `conversion_28d` | float | | ranking feature | analytics, nightly |
| `listed_at` | date | | sort, ranking feature | catalog |
| `embedding` | knn_vector, 512 dims | k-NN only | | embedding pipeline, added in 1.5 ([SPEC-066](@SPEC-066)) |

## Mapping excerpt

```json
{
  "settings": {
    "index": { "number_of_shards": 4, "number_of_replicas": 2, "knn": true, "refresh_interval": "1s" }
  },
  "mappings": {
    "dynamic": "strict",
    "properties": {
      "title": {
        "type": "text",
        "analyzer": "standard_en",
        "fields": { "exact": { "type": "text", "analyzer": "lowercase_only" } }
      },
      "part_numbers": { "type": "keyword", "normalizer": "lowercase" },
      "attributes": { "type": "object", "dynamic": true },
      "price_minor": { "type": "long" },
      "embedding": {
        "type": "knn_vector",
        "dimension": 512,
        "method": { "name": "hnsw", "engine": "lucene", "space_type": "cosinesimil", "parameters": { "m": 16, "ef_construction": 128 } }
      }
    }
  }
}
```

Suggestions live in their own index ([SPEC-064](@SPEC-064)). `attributes` is the one dynamic object, so new attributes from [SPEC-079](@SPEC-079) can become facets without a re-index; every other field is strict.

## Sizes

| Measure | Value, September 2026 |
| -- | -- |
| Documents | 3.1 million |
| Primary size without vectors | 21 GB |
| Vectors, HNSW graph | 7.1 GB |
| Changes applied per day | 2.4 million, peak 610 per second |
| Change to searchable, p99 | 4 seconds |

## Version history

| Version | Date | Change |
| -- | -- | -- |
| 1.0 | 2025-06-02 | First mapping on OpenSearch |
| 1.1 | 2025-09-15 | `title.exact` for the exact-match clause ([RFC-055](@RFC-055)) |
| 1.2 | 2025-10-20 | `attributes.*` as facets ([RFC-056](@RFC-056)) |
| 1.3 | 2025-12-08 | `conversion_28d` for ranking ([SPEC-061](@SPEC-061)) |
| 1.4 | 2026-03-02 | `part_numbers` ([RN-055](@RN-055)) |
| 1.5 | 2026-09-14 | `embedding`, 4 primary shards ([RN-059](@RN-059)) |
| 2.0 | planned | Language sub-fields ([RFC-063](@RFC-063)) |

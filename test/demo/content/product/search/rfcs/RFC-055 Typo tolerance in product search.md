| Status | Implemented |
| -- | -- |
| Created | 2025-07-04 |
| Authors | DemoNina |
| Reviewers | DemoHeidi, DemoOscar |
| Target | Q3 2025 |
| Decision | Within [ADR-012 Use OpenSearch for product search](@ADR-012); no new ADR |

## Summary

Match search terms with up to one or two typing mistakes, while still ranking exact matches first, so that "wardrobw" finds wardrobes instead of an empty page.

## Motivation

The relevance baseline ([RN-051](@RN-051)) found a zero-result rate of 14.2 % for tail queries, and 41 % of a sample of those contained a misspelling. Each empty page is a lost search: only 9 % of buyers who see one search again within the session.

## Proposal

### Fuzzy matching with an exact-match boost

Each query is sent as a `bool` query with two clauses: an exact `multi_match` that carries most of the score, and a fuzzy `multi_match` that only recovers what the exact clause misses.

```json
{
  "query": {
    "bool": {
      "should": [
        {
          "multi_match": {
            "query": "oak wardrobw",
            "fields": ["title^4", "brand^3", "category_path^2", "description"],
            "type": "best_fields",
            "boost": 3
          }
        },
        {
          "multi_match": {
            "query": "oak wardrobw",
            "fields": ["title^4", "brand^3", "category_path^2"],
            "fuzziness": "AUTO:4,8",
            "prefix_length": 1,
            "max_expansions": 30
          }
        }
      ],
      "minimum_should_match": 1
    }
  }
}
```

* `AUTO:4,8` allows no edit for terms under 4 characters, one edit for 4 to 7, and two from 8 characters.
* `prefix_length: 1` keeps the first character fixed; real misspellings rarely change it, and it cuts expansions by about 80 %.
* The description field is left out of the fuzzy clause: it is long and noisy, and fuzzy hits there are mostly accidental.

### Where it runs

```mermaid
flowchart LR
    q[Query from web or app] --> s[search-svc]
    s --> n[Normalise: lowercase, trim, unicode NFKC]
    n --> b[Build bool query]
    b --> os[(OpenSearch product index)]
    os --> r[Re-rank and return]
```

The change is limited to the query builder in `search-svc`; the index mapping ([SPEC-060](@SPEC-060)) stays as it is.

## Alternatives

| Option | Recall gain on tail | Latency cost | Effort | Why not |
| -- | -- | -- | -- | -- |
| **Fuzzy clause with exact boost** | **high** | **about 10 ms** | **small** | Chosen |
| Spell-correct the query, then search | high | 25 ms for the speller | medium | Corrects valid rare words ("bodum" to "bottom") |
| Phonetic analyser on the title | medium | none at query time | re-index | Poor for brand names and non-English words |
| "Did you mean" link only | low | none | small | Buyer still sees an empty page first |

## Rollout

- [X] Query builder behind the feature flag `search.typo_tolerance` ([ADR-022](@ADR-022))
- [X] A/B test for 14 days ([RN-052](@RN-052))
- [X] Rollout to 100 % on 2025-09-29
- [X] Remove the flag and the old query path

## Open questions

* Three-letter terms stay exact. Known misspellings of short words go into the synonym file ([SPEC-063](@SPEC-063)).

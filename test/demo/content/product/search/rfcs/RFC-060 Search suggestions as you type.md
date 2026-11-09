| Status | Implemented |
| -- | -- |
| Created | 2025-08-25 |
| Authors | DemoOscar |
| Reviewers | DemoJudy, DemoKen |
| Target | Q4 2025 |
| Decision | Within [ADR-012 Use OpenSearch for product search](@ADR-012); index in [SPEC-064](@SPEC-064) |

## Summary

Show up to eight suggestions under the search box after the first two characters: popular queries, categories and brands that start with what the buyer typed, ranked by how often they lead to a purchase.

## Motivation

Search boxes with suggestions shorten queries and steer buyers towards terms that have results. On DemoMart, 14.2 % of tail searches return nothing, mostly because they are misspelled or phrased in ways no listing uses ([RN-051](@RN-051)). The app's search box is the most-used entry point after the home screen, and typing on a phone is slow: the median app search takes 7.4 seconds from first tap to submit.

## Proposal

@@picture:rfc-060-path@@

### Candidates

* Past queries searched by at least 3 distinct sessions in 90 days and with at least one result (2.6 million today).
* Category names and their common alternative names (12,000).
* Brand names with at least 20 active listings (31,000).

Each candidate gets a weight: purchases following the query in 90 days, plus a small floor so new categories can appear.

### Serving

A completion suggester with a category context, rebuilt every 15 minutes from the analytics events ([SPEC-065](@SPEC-065)). [RN-056](@RN-056) showed p99 under 15 ms up to 8 million entries.

```json
{
  "suggest": {
    "q": {
      "prefix": "stan",
      "completion": {
        "field": "suggest",
        "size": 8,
        "skip_duplicates": true,
        "fuzzy": { "fuzziness": 1, "min_length": 4, "prefix_length": 2 },
        "contexts": { "top_category": ["c-1000"] }
      }
    }
  }
}
```

The web shop and app wait 80 ms after the last keystroke before asking, and cancel requests that a newer keystroke overtakes.

## Alternatives

| Option | p99 at 2.6 million entries | Freshness | Why not |
| -- | -- | -- | -- |
| **Completion suggester** | **10 ms** | **15 minutes** | Chosen |
| Edge n-gram field | 41 ms | live | Over budget beyond 4 million entries ([RN-056](@RN-056)) |
| Prefix trie in search-svc memory | 3 ms | per deploy | Every pod holds 3 GB; rebuild on deploy only |

## Rollout

- [X] Suggestion index and nightly candidate job
- [X] Web shop behind a flag, then 100 %
- [X] App, from release 5.12
- [X] Blocklist for offensive and unsafe suggestions, reviewed weekly
- [X] 15-minute rebuild instead of nightly

## Open questions

* Show product thumbnails in suggestions? Tested in a mock-up; postponed until the suggestion API can return listing ids without a second request.

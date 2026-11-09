| Status | Accepted |
| -- | -- |
| Date | 2025-05-24 |
| Authors | DemoGrace |
| Reviewers | DemoIvan, DemoLaura |

## Context

Product search runs as `LIKE` and trigram queries against the catalog database. It has no typo tolerance, no relevance ranking beyond sort by sales, and a search for a common word takes up to 900 ms at p95. 31 % of searches end without a click ([RN-051](@RN-051)). The catalog has 4.2 million listings in nine languages.

## Decision

Product search moves to **OpenSearch**, in a managed cluster run by `search-svc`.

* One index per language, mapping in [SPEC-060](@SPEC-060); listings are fed from change data capture ([ADR-036](@ADR-036)).
* BM25 with field boosts for the first release; learning to rank comes later ([RFC-057](@RFC-057)).
* The query API in [SPEC-059](@SPEC-059) hides OpenSearch from the web shop and the app.
* Cluster: 3 dedicated masters, 6 data nodes, 2 replicas per shard.

```json
{
  "query": {
    "multi_match": {
      "query": "oak side table",
      "fields": ["title^3", "brand^2", "category", "description"],
      "fuzziness": "AUTO"
    }
  }
}
```

## Options considered

| Option | p95 latency (prototype) | Typo tolerance | Language analysers | Licence | Verdict |
| -- | -- | -- | -- | -- | -- |
| **OpenSearch (managed)** | **74 ms** | **yes** | **all nine languages** | **Apache 2.0** | **Chosen** |
| Elasticsearch | 70 ms | yes | all nine | not open source | Licence terms |
| Hosted search service | 35 ms | yes | seven of nine | proprietary | Cost per query at our volume |
| PostgreSQL full text (today) | 900 ms | no | partial | open | The problem we have |

## Consequences

* Search quality can be tuned without touching the catalog database.
* Search is eventually consistent with the catalog, by seconds.
* A new cluster to size and monitor; [RN-059](@RN-059) checks peak latency.

## Follow-up

- [X] Index mapping and analysers for nine languages
- [X] Shadow traffic for two weeks
- [ ] Switch the app to the new query API

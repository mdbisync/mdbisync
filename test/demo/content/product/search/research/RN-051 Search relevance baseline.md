| Status | Complete |
| -- | -- |
| Date | 2025-06-20 |
| Authors | DemoHeidi, DemoNina |
| Led to | [RFC-055 Typo tolerance](@RFC-055), [RFC-057 Learning to rank](@RFC-057) |

## Question

How good is product search on the new OpenSearch cluster ([ADR-012](@ADR-012)) before we change any ranking? We need one number per query class that later work can be compared against.

## Method

* **Queries:** 1,800 queries sampled from four weeks of search logs, stratified into head (top 1,000 queries, 52 % of traffic), torso (next 20,000, 31 %) and tail (everything else, 17 %); 600 per class.
* **Judgements:** the top 10 results of each query graded 0 to 3 by two trained judges following [SPEC-067](@SPEC-067); disagreements of more than one grade went to a third judge. Agreement before adjudication: weighted kappa 0.71.
* **Metrics:** NDCG@10 on the graded results, and zero-result rate from the logs of the same four weeks.
* **Ranking under test:** BM25 on title, brand, category path and description with the field boosts of [SPEC-060](@SPEC-060); no learned ranking, no typo handling.

## Results

@@picture:rn-051-ndcg@@

@@table:rn-051-ndcg@@

@@csv:rn-051-ndcg@@

| Query class | Share of traffic | Zero-result rate | Searches followed by a click |
| -- | -- | -- | -- |
| Head | 52 % | 0.4 % | 61 % |
| Torso | 31 % | 3.9 % | 44 % |
| Tail | 17 % | 14.2 % | 27 % |

## Findings

* Head queries are in good shape (NDCG@10 0.71): they are short, mostly category or brand words, and BM25 handles them.
* Tail queries are poor (0.38) and often return nothing. In a sample of 200 tail zero-result queries, 41 % contained a misspelling ("wardrobw", "hedphones"), 23 % used a word not in any listing ("sofa" against listings that say "couch"), and 18 % combined too many attributes.
* Torso queries lose most from ranking, not recall: relevant products exist but sit at positions 6 to 20.

> [!NOTE]
> The judged set is kept frozen as the relevance baseline set. Every ranking change since then reports NDCG@10 against it.

## Recommendation

Fix recall in the tail first with typo tolerance ([RFC-055](@RFC-055)) and synonyms ([SPEC-063](@SPEC-063)), then improve torso ranking with learning to rank ([RFC-057](@RFC-057)).

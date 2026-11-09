| Status | Complete |
| -- | -- |
| Date | 2025-09-12 |
| Authors | DemoOscar |
| Led to | [RFC-060 Search suggestions as you type](@RFC-060), [SPEC-064 Suggestion index](@SPEC-064) |

## Question

Suggestions must appear while the buyer types, which leaves about 50 ms for the server at p99. How large can the suggestion index grow before OpenSearch's completion suggester misses that budget, and how does it compare with an edge n-gram index?

## Method

* Two index designs from [RFC-060](@RFC-060): the completion suggester (an in-memory finite state transducer) and a `search_as_you_type` field with edge n-grams.
* Index sizes from 0.5 to 16 million entries, built from past queries, category names and brand names, weighted by 90-day frequency.
* Load: 2,000 prefix requests per second replayed from real keystroke sequences, on a dedicated 3-node cluster with 16 GB heap per node.

## Results

@@picture:rn-056-latency@@

@@table:rn-056-latency@@

@@csv:rn-056-latency@@

## Findings

* The completion suggester stays at 9 to 14 ms at p99 up to 8 million entries and reaches 21 ms at 16 million. Its cost is memory: 1.9 GB of heap per million entries with contexts.
* The edge n-gram field passes 50 ms at 4 million entries and reaches 118 ms at 16 million, because short prefixes such as "s" or "sh" match millions of entries before scoring.
* Today's candidate set has 2.6 million entries; the three-year forecast is 6 million, comfortably inside the completion suggester's range.

> [!WARNING]
> The completion suggester cannot filter by stock or by seller status after the fact. Suggestions for products that sell out are removed at the next index rebuild, every 15 minutes ([SPEC-064](@SPEC-064)).

## Recommendation

Use the completion suggester with category contexts, and cap the index at 8 million entries by dropping entries with fewer than 3 searches in 90 days.

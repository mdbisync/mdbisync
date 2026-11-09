| Status | Complete |
| -- | -- |
| Date | 2026-06-12 |
| Authors | DemoNina |
| Led to | [RFC-063 Search in five more languages](@RFC-063) |

## Question

DemoMart's search analyses every listing as English. How many listings and searches are in other languages, and how much worse is search for them?

## Method

* Language detection on the title and description of all 3.1 million active listings, and on 30 days of searches (19.8 million, from 2026-05-01). Texts under 20 characters were assigned the seller's or buyer's interface language.
* Relevance per language: 200 judged queries for each of the five largest non-English languages, graded with [SPEC-067](@SPEC-067), compared against the English results on the frozen baseline set.

## Results

@@picture:rn-060-share@@

@@table:rn-060-share@@

@@csv:rn-060-share@@

| Language | NDCG@10 | Zero-result rate |
| -- | -- | -- |
| English | 0.66 | 1.7 % |
| German | 0.47 | 6.3 % |
| French | 0.51 | 5.1 % |
| Spanish | 0.52 | 4.8 % |
| Italian | 0.49 | 5.6 % |
| Dutch | 0.44 | 7.2 % |

## Findings

* 17 % of searches are in one of the five languages, but they get clearly worse results: NDCG@10 between 0.44 and 0.52, against 0.66 for English.
* German and Dutch suffer most. Compound words such as "Holzschreibtisch" (wooden desk) are not split, so they match only listings with the exact compound.
* Listings and searches roughly match per language, except Dutch, where buyers search in Dutch (3.1 % of searches) more than sellers list in it (1.9 %), so many Dutch searches have to match English listings.

## Recommendation

Add language-specific analysers for the five languages, with decompounding for German and Dutch, and a cross-language synonym layer for the most frequent product words ([RFC-063](@RFC-063)). The multilingual embedding model of [RN-057](@RN-057) can help with similar products across languages.

| Status | Complete |
| -- | -- |
| Date | 2026-01-23 |
| Authors | DemoJudy |
| Led to | [RFC-062 Recovering from zero-result searches](@RFC-062), [RFC-058 Synonyms managed by merchandisers](@RFC-058) |

## Question

After typo tolerance ([RN-052](@RN-052)) the zero-result rate fell to 1.9 %. Where are the remaining empty pages, and what would fix them?

## Method

* All searches from 2025-12-01 to 2025-12-31: 21.4 million, of which 398,000 returned no result.
* Each zero-result search was assigned to the category the buyer was browsing, or to the category predicted by the query classifier when they searched from the home page.
* A sample of 1,000 zero-result queries was read and labelled by cause.

## Results

@@picture:rn-055-rate@@

@@table:rn-055-rate@@

@@csv:rn-055-rate@@

| Cause (sample of 1,000) | Share | Example query |
| -- | -- | -- |
| Vocabulary gap, the word is not in listings | 34 % | "settee" against listings that say "sofa" |
| Too many attributes, no product matches all | 27 % | "green velvet 3 seater sofa with storage" |
| Product not sold on DemoMart | 19 % | "car tyres" |
| Remaining misspelling | 11 % | "jeweler" against "jewellery" |
| Model or part number | 9 % | "xk-2201 filter" |

## Findings

* Furniture and home has the highest rate, 4.1 %, driven by vocabulary gaps and long attribute queries.
* Electronics has many part-number queries; listings carry part numbers in the description, which is analysed with the standard tokenizer and splits "xk-2201" into two terms.
* Fashion is lowest at 0.9 %: listings there have rich attributes and synonyms already maintained by hand ([SPEC-063](@SPEC-063)).

## Recommendation

* For too-many-attribute queries, relax the query step by step instead of showing an empty page ([RFC-062](@RFC-062)).
* For vocabulary gaps, let merchandisers manage synonyms per category ([RFC-058](@RFC-058)).
* Index part numbers in a keyword sub-field ([SPEC-060](@SPEC-060), version 1.4).

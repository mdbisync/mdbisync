| Status | Complete |
| -- | -- |
| Date | 2026-05-29 |
| Authors | DemoHeidi, DemoNina |
| Led to | [ADR-045 Use vector search for similar products](@ADR-045), [RFC-059 Similar products with vector search](@RFC-059) |

## Question

The "Similar products" row on product pages is built from co-purchases today and is empty for 46 % of products, mostly new or niche ones. Which open embedding model finds good similar products from a listing's title, attributes and main image, at a cost we can run on our own nodes?

## Method

* **Candidates:** a small text-only sentence encoder (384 dimensions), a base-size text encoder (768 dimensions), a multilingual base text encoder (768 dimensions), and a joint image and text model of the open CLIP family (512 dimensions), all with open weights, run on our CPU inference nodes.
* **Input:** title, brand, category path and the top five attributes; for the joint model also the main image at 224 pixels.
* **Ground truth:** 2,400 seed products from 24 categories. For each, judges marked which of the top 20 neighbours from each model are acceptable substitutes ([SPEC-067](@SPEC-067), similarity variant).
* **Measures:** precision@10 of acceptable substitutes; encoding time per listing on one CPU core.

## Results

@@picture:rn-057-precision@@

@@table:rn-057-precision@@

@@picture:rn-057-encode@@

@@csv:rn-057-precision@@

## Findings

* The joint image and text model is best overall (0.81) and wins clearly in fashion and furniture, where the picture says more than the title.
* For electronics, text models are as good or better: model names and specifications matter, photos look alike.
* The multilingual model loses little against the base model on English listings and is the only one that keeps quality on listings in other languages ([RN-060](@RN-060)).
* The joint model is the slowest to encode at 41 ms per listing, which still re-encodes the full catalogue of 3.1 million listings in under 9 hours on 4 nodes.

## Recommendation

Use the joint image and text model for similar products, with a text-only fallback for listings without an image, and store vectors in the existing OpenSearch cluster ([ADR-045](@ADR-045)). The pipeline is specified in [SPEC-066](@SPEC-066).

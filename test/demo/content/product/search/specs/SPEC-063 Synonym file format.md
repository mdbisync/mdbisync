| Status | Stable |
| -- | -- |
| Version | 1.3 |
| Updated | 2025-11-03 |
| Owner | DemoNina |
| Applies to | The global synonym list of product search; per-category sets are proposed in [RFC-058](@RFC-058) |

## Overview

Synonyms widen a query with words that mean the same thing in product listings: "couch" also finds "sofa". They are applied at search time only, by a `synonym_graph` filter in the query analyser of `search-svc`, so changing them never requires re-indexing ([SPEC-060](@SPEC-060)).

The list lives in `search-config/synonyms/global.txt` and is loaded at deploy. It has 1,140 rules as of November 2025.

## Rule types

| Type | Syntax | Effect | Example |
| -- | -- | -- | -- |
| Equivalent | `a, b, c` | Any term finds all of them | `sofa, couch, settee` |
| One-way | `a => b` | `a` also finds `b`, not the reverse | `loveseat => sofa` |
| Correction | `a => b` | A known misspelling of a short word | `rgu => rug` |
| Multi-word | `a b, c` | Phrases count as one unit | `bean bag, beanbag` |

## Example

```text
# Furniture
sofa, couch, settee
loveseat => sofa
wardrobe, armoire

# Fashion
trainers, sneakers, running shoes
hoodie, hooded sweatshirt
tshirt, t-shirt, tee

# Short words that typo tolerance leaves alone
rgu => rug
bga => bag
mic => microphone
```

## Rules for editors

1. One-way rules for anything narrower: "loveseat" is a kind of sofa, but a sofa is not a loveseat.
2. No rule for a word with more than one meaning across categories ("tablet", "pen", "bow"); wait for category sets.
3. Every change lists, in the pull request, the five most frequent queries it affects and their result counts before and after, taken from the dry-run tool.
4. Corrections only for terms under four characters; longer misspellings are handled by typo tolerance ([RFC-055](@RFC-055)).

## Analyser

```json
{
  "search_analyzer_en": {
    "tokenizer": "standard",
    "filter": ["lowercase", "asciifolding", "global_synonyms", "english_stem"]
  },
  "global_synonyms": {
    "type": "synonym_graph",
    "synonyms_path": "analysis/global.txt",
    "updateable": true
  }
}
```

## Limits

| Item | Limit |
| -- | -- |
| Rules | 5,000 |
| Terms in one equivalent rule | 8 |
| Words in one multi-word term | 4 |

## Version history

| Version | Date | Change |
| -- | -- | -- |
| 1.0 | 2025-06-02 | Format and first 380 rules |
| 1.1 | 2025-08-18 | One-way rules |
| 1.2 | 2025-10-01 | Corrections for short words after [RN-052](@RN-052) |
| 1.3 | 2025-11-03 | Removed "pen" and "tablet" rules after wrong results; rule 2 added |

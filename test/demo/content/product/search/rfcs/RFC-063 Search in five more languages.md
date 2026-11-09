| Status | Accepted |
| -- | -- |
| Created | 2026-06-22 |
| Authors | DemoNina |
| Reviewers | DemoHeidi, DemoOscar, DemoJudy |
| Target | Q4 2026 |
| Decision | Within [ADR-012 Use OpenSearch for product search](@ADR-012); mapping change in [SPEC-060](@SPEC-060) version 2.0 |

## Summary

Analyse listings and queries in German, French, Spanish, Italian and Dutch with language-specific analysers, split German and Dutch compound words, and search each query in its own language and in English.

## Motivation

17 % of searches are in one of these five languages, and their results are clearly worse than English ones: NDCG@10 between 0.44 and 0.52 against 0.66, and zero-result rates up to 7.2 % ([RN-060](@RN-060)). Compound words such as "Holzschreibtisch" match only listings with the exact compound.

## Proposal

@@picture:rfc-063-fields@@

### Language per listing

The listing's language is detected when it is indexed (title and description, at least 20 characters; otherwise the seller's interface language) and stored in `lang`. Text fields get one sub-field per supported language; only the listing's own language sub-field and the English one are filled.

```json
{
  "title": {
    "type": "text",
    "analyzer": "standard_en",
    "fields": {
      "de": { "type": "text", "analyzer": "title_de" },
      "fr": { "type": "text", "analyzer": "title_fr" },
      "es": { "type": "text", "analyzer": "title_es" },
      "it": { "type": "text", "analyzer": "title_it" },
      "nl": { "type": "text", "analyzer": "title_nl" }
    }
  }
}
```

### Decompounding

German and Dutch analysers use a dictionary decompounder with a word list of 180,000 entries, filtered to product vocabulary, keeping the original compound too:

```json
{
  "title_de": {
    "tokenizer": "standard",
    "filter": ["lowercase", "german_decompounder", "german_normalization", "german_stem"]
  },
  "german_decompounder": {
    "type": "hyphenation_decompounder",
    "word_list_path": "analysis/de-product-words.txt",
    "hyphenation_patterns_path": "analysis/de-hyphenation.xml",
    "only_longest_match": true,
    "min_subword_size": 4
  }
}
```

### Queries

`search-svc` detects the query language (with the buyer's interface language as a prior) and searches the matching sub-field and the English field, boosting the matching language by 1.5.

## Alternatives

| Option | Expected NDCG@10, German | Index growth | Why not |
| -- | -- | -- | -- |
| One index per language | 0.61 | +95 % | Listings in two languages are duplicated; five more indices to run |
| **Sub-fields per language** | **0.60** | **+18 %** | Chosen |
| Translate every listing to English | 0.55 | none | Translation cost for 3.1 million listings and every edit |
| Multilingual embeddings only | 0.52 | +7 GB | Weak for exact terms and part numbers |

Expected values are from a prototype on 200 judged German queries ([SPEC-067](@SPEC-067)).

## Rollout

- [ ] Language detection at indexing, stored in `lang`
- [ ] Re-index with sub-fields, behind an alias switch
- [ ] German and Dutch first, with decompounding
- [ ] French, Spanish and Italian
- [ ] Re-measure relevance per language and repeat [RN-060](@RN-060)

## Open questions

* Synonyms per language: the category sets of [RFC-058](@RFC-058) need a language key.

| Status | Stable |
| -- | -- |
| Version | 2.0 |
| Updated | 2025-12-15 |
| Owner | DemoJudy |
| Applies to | Facets on category pages and search results, web shop and app ([RFC-056](@RFC-056)) |

## Overview

Which facets a category shows, in which order and how, is configured in YAML files in the `search-config` repository, one file per top-level category. Child categories inherit their parent's facets and may add, hide or reorder them. `search-svc` reloads the files within a minute of a merge.

## File format

```yaml
category: c-1000            # Furniture and home
inherit: true
facets:
  - name: price
    display: range
    ranges_minor: [2500, 5000, 10000, 25000]
  - name: size
    attribute: attributes.width_cm
    display: range
    ranges: [60, 100, 140, 180]
    unit: cm
  - name: brand
    display: checklist
    max_values: 12
    search_box: true
  - name: delivery_by
    display: date
  - name: colour
    attribute: attributes.colour
    display: swatches
  - name: material
    attribute: attributes.material
    display: checklist
    max_values: 8
hidden: [seller_location]
```

## Fields

| Field | Type | Required | Description |
| -- | -- | -- | -- |
| `category` | category id | yes | The category the file configures |
| `inherit` | boolean | no, default true | Start from the parent's list |
| `facets[].name` | string | yes | Unique within the category; used in `filter=` of [SPEC-059](@SPEC-059) |
| `facets[].attribute` | field path | for attribute facets | An `attributes.*` field of the index ([SPEC-060](@SPEC-060)) |
| `facets[].display` | enum | yes | `checklist`, `swatches`, `range`, `rating`, `date`, `toggle` |
| `facets[].max_values` | integer | no, default 8 | Values shown before "show all" |
| `facets[].search_box` | boolean | no | A filter box for long value lists, such as brands |
| `hidden` | list of names | no | Inherited facets not shown here |

## Built-in facets

| Name | Display | Notes |
| -- | -- | -- |
| `price` | range | Ranges in minor units of the buyer's currency |
| `rating` | rating | 4 and up, 3 and up |
| `delivery_by` | date | Next 1, 3 or 7 days to the buyer's country |
| `in_stock` | toggle | On by default in search, off on category pages |
| `seller_location` | checklist | Hidden by default since 2.0 |

## Order

The default order since version 2.0, from the usage study ([RN-058](@RN-058)): price, size, brand, delivery by date, colour, rating, then category-specific attributes. A category file may reorder, but not move `price` below position 3.

## Validation

A merge is blocked when:

* an `attribute` does not exist in the index mapping, or has fewer than 50 listings with a value in that category;
* a facet name repeats within a category after inheritance;
* `ranges` are not strictly increasing.

## Version history

| Version | Date | Change |
| -- | -- | -- |
| 1.0 | 2025-09-01 | First format, price, brand and rating only |
| 1.1 | 2025-10-20 | Attribute facets, inheritance |
| 2.0 | 2025-12-15 | `delivery_by` moved up, `seller_location` hidden, `search_box` added |

| Status | Stable |
| -- | -- |
| Version | 3.0 |
| Updated | 2026-04-28 |
| Owner | DemoOscar |
| Applies to | Seller Hub, the bulk editor, [bulk catalog import](@SPEC-041) and the [products endpoints](@SPEC-036) |

## Overview

One set of rules decides whether a listing can be saved and whether it can be published. Seller Hub, the bulk editor ([RFC-074](@RFC-074)) and the public API all call the same validator in `catalog-svc`, so a listing valid in one place is valid everywhere.

A listing can be saved as a draft with errors of severity **warning**; it can be published only without errors of severity **error**.

## Fields

| Field | Type | Required to publish | Validation | Severity |
| -- | -- | -- | -- | -- |
| `title` | string | yes | 10 to 150 characters; no more than 30 % capital letters | error |
| `description` | Markdown subset | yes | 50 to 10,000 characters; no links to other shops | error |
| `sku` | string | yes | 1 to 64 characters of `A-Z 0-9 - _ .`; unique per seller | error |
| `category_id` | string | yes | A leaf category | error |
| `price` | money | yes | Integer minor units, 1 to 10,000,000 ([ADR-020](@ADR-020)) | error |
| `sale_price` | money | no | Below `price`, at least 1 % below | error |
| `stock` | integer | yes | 0 to 999,999 | error |
| `photos` | list of images | yes | 1 to 12; JPEG, PNG or WebP; short side at least 500 px | error |
| `photos` (quality) | list of images | | Short side at least 1,000 px | warning |
| `attributes` | map | per category | Values from the category's list; units converted to the category's unit | error for required, warning for optional |
| `gtin` | string | per category | Valid GTIN-8, -12, -13 or -14 check digit | error |
| `shipping_profile_id` | string | yes | A profile of the same seller | error |

## Error format

The validator returns every problem at once, not only the first:

```json
{
  "valid": false,
  "publishable": false,
  "problems": [
    { "field": "sale_price", "code": "sale_price_not_below_price", "severity": "error" },
    { "field": "photos[0]", "code": "image_short_side_below_1000", "severity": "warning" },
    { "field": "attributes.material", "code": "attribute_missing", "severity": "error" }
  ]
}
```

In the public API, the same list appears in the `errors` member of a problem details response ([SPEC-032](@SPEC-032)).

## Codes

| Code | Meaning |
| -- | -- |
| `title_length` | Title shorter than 10 or longer than 150 characters |
| `title_shouting` | More than 30 % capital letters |
| `sku_duplicate` | Another listing of the seller has this SKU |
| `category_not_leaf` | Category has subcategories |
| `price_out_of_range` | Price below 1 or above 10,000,000 minor units |
| `sale_price_not_below_price` | Sale price is not at least 1 % below price |
| `image_short_side_below_500` | A photo is too small to publish |
| `image_short_side_below_1000` | A photo is small; lowers the [quality score](@SPEC-085) |
| `attribute_missing` | A required attribute of the category is empty |
| `attribute_value_unknown` | Value not in the category's list |
| `gtin_check_digit` | GTIN check digit does not match |

## Version history

| Version | Date | Change |
| -- | -- | -- |
| 1.0 | 2025-02-10 | First version |
| 2.0 | 2025-08-04 | Warnings separate from errors; drafts may have warnings |
| 3.0 | 2026-04-28 | One validator for Seller Hub, bulk editor and API; `sale_price` must be 1 % below |

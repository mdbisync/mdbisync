| Status | Stable |
| -- | -- |
| Version | 2.4 |
| Updated | 2026-06-16 |
| Owner | DemoFrank |
| Applies to | `/v2/products` and its variants |

## Overview

A product is what a buyer sees as one listing; a variant is one buyable version of it (a size, a colour). Prices and stock belong to variants. Products are owned by `catalog-svc`; changes reach search within seconds ([ADR-036](@ADR-036)). Listing rules match Seller Hub's ([SPEC-079](@SPEC-079)).

## Endpoints

| Method | Path | Scope | Notes |
| -- | -- | -- | -- |
| `GET` | `/products` | `products:read` | Cursor-paged ([SPEC-033](@SPEC-033)); filters `status`, `category_id`, `updated_since` |
| `GET` | `/products/{product_id}` | `products:read` | Includes variants |
| `POST` | `/products` | `products:write` | Creates a draft or active product |
| `PATCH` | `/products/{product_id}` | `products:write` | Partial update; send `version` to avoid lost updates |
| `DELETE` | `/products/{product_id}` | `products:write` | Archives; archived products disappear from search |
| `POST` | `/products/{product_id}/variants` | `products:write` | Adds a variant |
| `PATCH` | `/products/{product_id}/variants/{variant_id}` | `products:write` | Price, SKU, attributes |

## Product fields

| Field | Type | Required | Notes |
| -- | -- | -- | -- |
| `id` | string | read-only | `prd_` prefix |
| `title` | string | yes | 3 to 140 characters |
| `description` | string | no | Up to 5,000 characters, Markdown subset |
| `category_id` | string | yes | From the category tree |
| `status` | enum | yes | `draft`, `active`, `archived` |
| `images` | array | no | Up to 12 HTTPS URLs; fetched and resized by the CDN ([ADR-041](@ADR-041)) |
| `variants` | array | yes, at least one | See below |
| `version` | integer | read-only | Increases with every change |
| `updated_at` | timestamp | read-only | |

## Variant fields

| Field | Type | Required | Notes |
| -- | -- | -- | -- |
| `id` | string | read-only | `var_` prefix |
| `sku` | string | yes | Unique per seller |
| `price` | money | yes | Integer minor units and currency ([ADR-020](@ADR-020)) |
| `compare_at_price` | money | no | Shown struck through when higher than `price` |
| `attributes` | object | no | For example `{ "size": "M", "colour": "oak" }` |
| `weight_grams` | integer | yes | Used for shipping options |

Stock is not a product field; it is changed through `/inventory` ([SPEC-038](@SPEC-038)).

## Create a product

```http
POST /v2/products HTTP/1.1
Host: api.example.com
Authorization: Bearer dm_test_8f2c41
Idempotency-Key: 9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d
Content-Type: application/json

{
  "title": "Oak side table",
  "category_id": "cat_furniture_tables",
  "status": "active",
  "images": ["https://images.example.com/demo/oak-table-1.jpg"],
  "variants": [
    { "sku": "OAK-ST-45", "price": { "amount": 14900, "currency": "EUR" }, "attributes": { "height_cm": "45" }, "weight_grams": 6200 }
  ]
}
```

```http
HTTP/1.1 201 Created
Location: /v2/products/prd_01JD2M7R
```

## Update without losing changes

```json
{ "title": "Oak side table, oiled", "version": 7 }
```

If the product changed since version 7, the update fails with `409 conflict` and `current_version` ([SPEC-032](@SPEC-032)). Read it again and reapply the change.

## Events

Changes publish `catalog.product.updated.v1` and related events ([SPEC-018](@SPEC-018)); partners receive them as `product.updated` webhooks ([SPEC-040](@SPEC-040)).

## Version history

| Version | Date | Change |
| -- | -- | -- |
| 2.0 | 2025-11-18 | Products and variants in v2 |
| 2.2 | 2026-01-13 | `updated_since` filter |
| 2.4 | 2026-06-16 | `compare_at_price` |

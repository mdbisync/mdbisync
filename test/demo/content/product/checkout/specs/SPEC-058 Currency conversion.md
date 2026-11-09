| Status | Draft |
| -- | -- |
| Version | 0.2 |
| Updated | 2026-10-13 |
| Owner | DemoLaura |
| Applies to | demo-pay, catalog prices shown in the buyer's currency ([RFC-054](@RFC-054)) |

## Overview

Sellers price and are paid in euro. Buyers in a market with another currency see and pay prices converted with a daily rate table. The order keeps both currencies so refunds and payouts never convert again.

## Rate table

| Field | Type | Description |
| -- | -- | -- |
| `id` | string | `fx-<date>-<currency>`, for example `fx-2026-10-13-PLN` |
| `base` | string | Always `EUR` |
| `quote` | string | Buyer currency |
| `reference_rate` | decimal string | Daily reference rate at 06:00 UTC |
| `margin_bp` | integer | 150 = 1.5 % |
| `rate` | decimal string | reference rate times (1 + margin) |
| `valid_from`, `valid_to` | timestamp | 24 hours |

```json
{
  "id": "fx-2026-10-13-PLN",
  "base": "EUR",
  "quote": "PLN",
  "reference_rate": "4.2715",
  "margin_bp": 150,
  "rate": "4.3356",
  "valid_from": "2026-10-13T06:00:00Z",
  "valid_to": "2026-10-14T06:00:00Z"
}
```

## Converting a price

```text
quote_minor = round_half_up(eur_minor * rate / 10) * 10    # PLN rounded to 0.10
```

Example: 12.95 EUR is 1295 minor units; 1295 × 4.3356 = 5614.6, rounded to 5610, shown as 56.10 PLN.

## On the order

| Field | Example |
| -- | -- |
| `total` | 26,840 PLN minor units |
| `total_settlement` | 6,190 EUR minor units |
| `fx_table` | `fx-2026-10-13-PLN` |

A refund in PLN uses the order's table; the seller's ledger ([SPEC-057](@SPEC-057)) moves by the euro amount of the refunded lines.

## Open points

* Margin level against rate movement over a payout cycle.
* Whether prices in search sort by converted price.

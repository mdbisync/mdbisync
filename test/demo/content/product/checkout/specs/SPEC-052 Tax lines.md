| Status | Stable |
| -- | -- |
| Version | 1.1 |
| Updated | 2026-02-09 |
| Owner | DemoLaura |
| Applies to | tax-svc, orders-svc and invoices |

## Overview

Every order line carries one tax line computed by `tax-svc` at checkout ([RFC-051](@RFC-051)). Shipping carries its own tax line. Invoices, refunds and seller reports read tax only from tax lines and never recompute it.

## Tax line

| Field | Type | Description |
| -- | -- | -- |
| `line_id` | string | The order line, or `shipping:<group id>` |
| `jurisdiction` | string | Country whose VAT applies |
| `rate_bp` | integer | Rate in basis points: 2000 is 20 % |
| `amount` | money | Tax included in the line price ([ADR-020](@ADR-020)) |
| `basis` | string | `destination`, `origin` or `exempt` |
| `rate_table` | string | Id of the rate table used, for audits |

```json
{
  "line_id": "l1",
  "jurisdiction": "FR",
  "rate_bp": 550,
  "amount": { "amount": 125, "currency": "EUR" },
  "basis": "destination",
  "rate_table": "rt-2026-02-09-fr"
}
```

## Computation

Prices include tax. For a line price `p` in minor units and rate `r` in basis points:

```text
tax = round_half_up(p * r / (10000 + r))
```

The rounding happens per line, never on the order total. The order's tax total is the sum of its tax lines.

## Basis

| Basis | When |
| -- | -- |
| `destination` | Cross-border sale by a seller above the EU threshold |
| `origin` | Seller under the threshold, or domestic sale |
| `exempt` | Product code exempt in the jurisdiction |

## Rate codes

| Tax code | DE | FR | NL | PL | ES |
| -- | -- | -- | -- | -- | -- |
| `general` | 1900 | 2000 | 2100 | 2300 | 2100 |
| `books` | 700 | 550 | 900 | 500 | 400 |
| `food` | 700 | 550 | 900 | 500 | 1000 |
| `children_clothing` | 1900 | 2000 | 2100 | 2300 | 2100 |

Rates shown are the illustrative table of February 2026.

## Version history

| Version | Date | Change |
| -- | -- | -- |
| 1.0 | 2025-11-04 | First version |
| 1.1 | 2026-02-09 | `basis` and `rate_table` |

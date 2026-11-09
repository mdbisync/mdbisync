| Status | Stable |
| -- | -- |
| Version | 1.5 |
| Updated | 2026-02-24 |
| Owner | DemoHeidi |
| Applies to | demo-pay and the payment section of checkout |

## Overview

Every payment method is one of the types below. A type decides how the buyer confirms the payment, whether funds are authorised before shipping, and how refunds work. The order of methods on the payment section depends on the market ([RN-043](@RN-043)).

## Types

| Type | Confirmation | Authorise then capture | Refund | Markets |
| -- | -- | -- | -- | -- |
| `card` | Card form, 3-D Secure ([RFC-049](@RFC-049)) | yes | to the card | all |
| `saved_card` | Security code, often exempt | yes | to the card | all ([RFC-044](@RFC-044)) |
| `bank_transfer` | Redirect to the buyer's bank | no, paid at once | bank transfer | NL, PL, DE |
| `wallet` | Wallet sheet on the device | yes | to the wallet | all |
| `voucher_balance` | None | no, deducted at once | back to the balance | all |

## Method object

```json
{ "type": "bank_transfer", "bank_id": "bnk_nl_07", "return_url": "https://shop.example.com/checkout/return" }
```

| Field | Types | Description |
| -- | -- | -- |
| `type` | all | One of the types above |
| `token` | `card`, `saved_card`, `wallet` | From the card vault or the wallet |
| `bank_id` | `bank_transfer` | The buyer's bank, from a list per market |
| `return_url` | redirect types | Where the bank sends the buyer back |

## Order on the page

```yaml
method_order:
  NL: [bank_transfer, card, saved_card, wallet]
  PL: [bank_transfer, card, saved_card, wallet]
  DE: [card, saved_card, bank_transfer, wallet]
  FR: [saved_card, card, wallet]
  ES: [saved_card, card, wallet]
```

Saved cards come first wherever the buyer has one.

## Combinations

A voucher balance can pay part of an order; the rest goes to one other method. No other combination is allowed.

## Version history

| Version | Date | Change |
| -- | -- | -- |
| 1.0 | 2025-01-27 | `card`, `bank_transfer` |
| 1.2 | 2025-06-17 | `saved_card`, `wallet` |
| 1.4 | 2025-11-24 | Buy-now-pay-later considered and not added ([RFC-048](@RFC-048)) |
| 1.5 | 2026-02-24 | `voucher_balance` and part payment |

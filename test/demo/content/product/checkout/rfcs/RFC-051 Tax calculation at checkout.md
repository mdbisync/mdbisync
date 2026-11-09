| Status | Implemented |
| -- | -- |
| Created | 2025-11-04 |
| Authors | DemoLaura |
| Reviewers | DemoHeidi, DemoFrank |
| Target | Q1 2026 |
| Decision | [ADR-020 Store money as integer minor units with a currency code](@ADR-020) |

## Summary

Calculate VAT per order line at checkout in a new `tax-svc`, from the product's tax code, the seller's origin and the delivery address, using a tax rules provider for rates. Store the result as tax lines on the order ([SPEC-052](@SPEC-052)).

## Motivation

Prices include VAT at the seller's home rate. Since cross-border sales above the EU threshold are taxed at the buyer's rate, sellers who sell abroad have to correct their invoices by hand: 1,240 corrections in September 2025. Reduced rates for books, food and children's clothing differ by country and change several times a year.

## Proposal

@@picture:rfc-051-tax@@

### Inputs and outputs

```json
{
  "cart_version": 7,
  "ship_to_country": "FR",
  "lines": [
    { "line_id": "l1", "seller_country": "DE", "tax_code": "books", "price": { "amount": 2400, "currency": "EUR" } },
    { "line_id": "l2", "seller_country": "DE", "tax_code": "general", "price": { "amount": 3990, "currency": "EUR" } }
  ]
}
```

```json
{
  "tax_lines": [
    { "line_id": "l1", "rate_bp": 550, "amount": { "amount": 125, "currency": "EUR" }, "jurisdiction": "FR" },
    { "line_id": "l2", "rate_bp": 2000, "amount": { "amount": 665, "currency": "EUR" }, "jurisdiction": "FR" }
  ]
}
```

Rates are in basis points; amounts in minor units. Tax is computed on the price including tax and rounded half up per line.

### Failure

If the provider does not answer within 300 ms, `tax-svc` uses the last cached rate table for the country, which is refreshed hourly. The order records which table it used.

## Alternatives

| Option | Why not |
| -- | -- |
| Keep seller-rate prices | Wrong tax on cross-border orders |
| Our own rate tables | Too many rates and changes to keep current |
| **Rules provider with a cached table** | Chosen |

## Rollout

- [X] `tax-svc` in shadow mode, comparing with seller invoices
- [X] Tax lines on orders for DE and FR sellers
- [X] All sellers
- [X] Invoices generated from tax lines

## Open questions

* Do sellers under the threshold want to opt out? Yes; their lines use the home rate, marked as such.

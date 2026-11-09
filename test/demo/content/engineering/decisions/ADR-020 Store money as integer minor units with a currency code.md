| Status | Implemented |
| -- | -- |
| Date | 2025-09-09 |
| Authors | DemoMike |
| Reviewers | DemoCarol, DemoJudy |

## Context

Prices, totals and refunds are stored as `numeric(12,2)` in some services, `float64` in others, and as strings in the public API. A refund of 19.99 EUR was computed as 19.989999 in `demo-pay` and rounded down, and seller payouts drifted by up to 0.07 EUR a month. The Japanese yen has no minor unit and the Bahraini dinar has three; a fixed two decimals is wrong for both.

## Decision

Money is an **integer amount in the currency's minor unit plus an ISO 4217 code**, everywhere: databases, events, gRPC and the public API v2.

* Minor units come from the ISO 4217 table: EUR has 2, JPY 0, BHD 3.
* Arithmetic happens on integers. Percentages (tax, fees) are applied with banker's rounding at one defined step, documented per calculation.
* Conversion between currencies is a separate, explicit step with a recorded rate ([SPEC-058](@SPEC-058)).

```proto
message Money {
  int64 amount = 1;   // minor units: 1999 means 19.99 EUR
  string currency = 2; // ISO 4217, for example "EUR"
}
```

```json
{ "total": { "amount": 1999, "currency": "EUR" } }
```

## Options considered

| Option | Exact | Works for 0 and 3 decimals | JSON-safe | Verdict |
| -- | -- | -- | -- | -- |
| **Integer minor units and currency** | **yes** | **yes** | **up to 2^53 minor units** | **Chosen** |
| Decimal string, for example "19.99" | yes | yes | yes | Every client parses differently |
| Decimal type in each language | yes | yes | no native JSON type | Inconsistent across Go, Kotlin, Swift and TypeScript |
| Floating point (part of today) | no | no | yes | The problem we have |

## Consequences

* Payout drift goes away; [SPEC-057](@SPEC-057) defines the rounding of fees.
* Every screen formats money with the currency's own rules.
* The public API's money fields change shape, one reason for `v2` ([ADR-016](@ADR-016)).

## Follow-up

- [X] `Money` type in the Go kit and shared Protobuf
- [X] Migrate `demo-pay` and `orders-svc` columns to `bigint` plus `char(3)`
- [X] Money fields in API v2

| Status | Stable |
| -- | -- |
| Version | 1.1 |
| Updated | 2026-06-30 |
| Owner | DemoLaura |
| Applies to | The seller performance page ([RFC-076](@RFC-076)), warnings and restrictions |

## Overview

Six metrics describe how well a seller serves buyers. Each is computed over a rolling 30-day window from order, shipment, return and message events, and compared with a warning threshold and a restriction threshold. A seller below the restriction threshold for 14 days in a row moves to `restricted` ([SPEC-078](@SPEC-078)).

## Metrics

| Metric | Definition | Better when | Warning at | Restriction at | Minimum sample |
| -- | -- | -- | -- | -- | -- |
| Late shipment rate | Orders handed to the carrier after the promised dispatch date, divided by orders shipped | lower | 4 % | 8 % | 20 orders |
| Cancellation rate | Orders cancelled by the seller, divided by orders received | lower | 2 % | 5 % | 20 orders |
| Return rate | Returns for "not as described" or "damaged", divided by orders delivered | lower | 3 % | 6 % | 20 orders |
| Valid tracking rate | Shipments with a tracking number the carrier recognises, divided by shipments | higher | 95 % | 90 % | 20 shipments |
| Response time | Median hours to the first answer to a buyer question | lower | 24 h | 48 h | 10 questions |
| Listing quality | Average [quality score](@SPEC-085) of active listings | higher | 50 | none | 5 listings |

Below the minimum sample, a metric shows "Not enough orders yet" and never leads to a warning.

Returns for "wrong size" or "changed mind" do not count: the seller cannot change them ([RN-076](@RN-076)).

## Status per metric

| Status | Rule |
| -- | -- |
| Good | Better than the warning threshold by more than 20 % of the gap to it |
| Watch | Within 20 % of the warning threshold |
| At risk | At or past the warning threshold |
| Restricted | At or past the restriction threshold for 14 days |

## Computation

Metrics are computed hourly in ClickHouse ([ADR-011](@ADR-011)) from the analytics events ([SPEC-020](@SPEC-020)):

```sql
SELECT
    seller_id,
    countIf(shipped_at > promised_dispatch_at) / count() AS late_shipment_rate
FROM shipments
WHERE shipped_at >= now() - INTERVAL 30 DAY
GROUP BY seller_id
HAVING count() >= 20
```

The results go to `seller_metrics_hourly`, which Seller Hub reads through GraphQL ([ADR-043](@ADR-043)):

```graphql
query Performance {
  seller {
    metrics(window: LAST_30_DAYS) {
      name
      value
      warningThreshold
      restrictionThreshold
      status
    }
  }
}
```

## Version history

| Version | Date | Change |
| -- | -- | -- |
| 1.0 | 2026-04-06 | First version, five metrics |
| 1.1 | 2026-06-30 | Listing quality added; minimum samples per metric |

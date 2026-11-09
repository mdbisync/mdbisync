| Status | Complete |
| -- | -- |
| Date | 2025-11-10 |
| Authors | DemoNina, DemoMike |
| Led to | [RFC-023 A retention policy for raw events](@RFC-023) |

## Question

How much storage will PostgreSQL and ClickHouse need by the end of 2027, and how much does a 13-month retention for raw events change that?

## Method

* Actual sizes at the end of each quarter of 2025, from the storage metrics.
* Forecast for 2026 and 2027 from order growth (plus 4 % a month, the plan of record) and event volume per order (flat since Q2 2025).
* ClickHouse forecast twice: keeping everything, and with raw events dropped after 13 months from Q1 2026, as [RFC-023](@RFC-023) proposes.
* PostgreSQL figures are the sum of all service databases, primaries only, without backups.

## Results

@@picture:rn-023-forecast@@

@@table:rn-023-forecast@@

@@csv:rn-023-forecast@@

## Findings

* ClickHouse grows from 410 GB today to 870 GB by the end of 2027 if nothing is deleted.
* With 13 months of raw events it drops to 250 GB in Q1 2026 and stays near 250 GB through 2027: new months replace expired ones, and daily aggregates add only about 2 GB a year.
* PostgreSQL grows from 1,900 GB to 3,400 GB, led by orders. Monthly partitions with archiving after 25 months ([RFC-019](@RFC-019)) would flatten that from 2027; the forecast does not yet include them.
* Storage cost for ClickHouse at the end of 2027: about 420 USD a month with retention against about 1,460 USD without, including replicas.

## Recommendation

Adopt 13 months of raw event retention ([RFC-023](@RFC-023)). Plan PostgreSQL storage for 3.5 TB by the end of 2027 and repeat this forecast once orders are partitioned.

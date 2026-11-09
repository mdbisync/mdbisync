| Status | Complete |
| -- | -- |
| Date | 2025-10-06 |
| Authors | DemoNina |
| Led to | [SPEC-025 ClickHouse events table](@SPEC-025), version 1.1 |

## Question

Which compression codec, per column, keeps the 13 months of analytics events ([ADR-027](@ADR-027)) smallest without making the common dashboard queries slower?

## Method

* One month of analytics events, 610 million rows, copied into test tables that differ only in codecs.
* Three columns that hold 88 % of the uncompressed bytes: `properties` (JSON text), `event_time` and `product_id`.
* Codecs: LZ4 (ClickHouse's default), ZSTD level 3 and ZSTD level 9; `event_time` also with `Delta` before each.
* Compression ratio from `system.columns`; query time as the median of 20 runs of the 30-day funnel query, cold cache.

## Results

@@picture:rn-017-ratio@@

@@table:rn-017-ratio@@

@@picture:rn-017-query@@

@@table:rn-017-query@@

@@csv:rn-017-ratio@@

## Findings

* `properties` compresses 4.2 times with LZ4 and 7.9 times with ZSTD(3). ZSTD(9) adds only 9 % more compression for that column.
* `event_time` with `Delta` and ZSTD(3) compresses 21.4 times: consecutive times in a sorted part differ by milliseconds.
* `product_id` gains little from ZSTD: values repeat, and LZ4 already finds them.
* The funnel query takes 1.9 s with LZ4 everywhere, 2.2 s with ZSTD(3) and 2.6 s with ZSTD(9). Decompression is not the bottleneck at level 3; at level 9 it starts to show.
* With the chosen codecs, one month of events takes 14.6 GB instead of 27.0 GB with LZ4 alone: 46 % less storage.

## Recommendation

* `properties`: `ZSTD(3)`.
* `event_time`, `ingested_at`: `Delta, ZSTD(3)`.
* Low-cardinality and id columns: keep `LZ4`.
* Do not use ZSTD(9): 9 % less space for 18 % slower queries.

Applied in [SPEC-025](@SPEC-025) version 1.1.

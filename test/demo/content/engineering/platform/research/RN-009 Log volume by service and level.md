| Status | Complete |
| -- | -- |
| Date | 2026-06-30 |
| Authors | DemoGrace |
| Led to | [SPEC-004 Log record format](@SPEC-004), version 1.4 |

## Question

Where does our log volume come from, and how much of it does anyone read?

## Method

* Log store ingestion for June 2026: 985 GB a day on average across the six largest services.
* Volume by service and level; queries against the log store by service for the same month.
* Sampled 1,000 `info` records per service and classified them by kind.

## Results

@@picture:rn-009-volume@@

@@table:rn-009-volume@@

@@csv:rn-009-volume@@

| Kind of `info` record | Share in the sample | Queried in June |
| -- | -- | -- |
| One record per successful request | 74 % | rarely |
| Lifecycle (start, stop, configuration) | 2 % | often |
| Business events (order placed, refund issued) | 9 % | often |
| Debug details logged at the wrong level | 15 % | never |

## Findings

* Three services (`api-gateway`, `search-svc`, `cart-svc`) wrote 601 GB a day, 61 % of the total, almost all of it per-request `info` records.
* Per-request records are rarely queried: traces ([SPEC-005](@SPEC-005)) answer the same questions with more context.
* 15 % of `info` records were debug details; they belong at `debug`, which is off in production.

## Recommendation

Sample successful per-request `info` records at 10 % in the three largest services, keep all `warn` and `error` records, and move debug details to `debug`. Expected volume: 444 GB a day, 55 % less, about 9,800 USD a month saved.

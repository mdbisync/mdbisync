| Status | Complete |
| -- | -- |
| Date | 2026-01-30 |
| Authors | DemoIvan, DemoFrank |
| Led to | [SPEC-041 Bulk catalog import](@SPEC-041), rejection of [RFC-038](@RFC-038) |

## Question

What is the fastest way for a partner to apply tens of thousands of catalog changes without hurting other API traffic: single calls, synchronous batches of 100, or an asynchronous import job?

## Method

* A copy of one large partner's catalog: 60,000 variants. The change: a new price for every variant.
* Three ways to apply it, each run five times on production-sized infrastructure in a quiet hour:
  * single `PATCH` calls at the write limit of 10 per second;
  * a prototype `PATCH /v2/inventory/batch` with 100 items per request, as in [RFC-038](@RFC-038);
  * a prototype import job: upload one CSV, workers apply it in chunks of 1,000 rows.
* We also measured gateway latency for other partners during each run.

## Results

@@picture:rn-034-time@@

@@table:rn-034-time@@

@@picture:rn-034-rows@@

@@table:rn-034-rows@@

@@csv:rn-034-rows@@

| Measure | Batches of 100 | Import job |
| -- | -- | -- |
| p99 latency of one request | 6.4 s | 0.2 s to create the job |
| Gateway timeouts | 1.7 % of batches | none |
| p99 latency for other partners during the run | up from 180 to 410 ms | unchanged |

## Findings

* **Single calls take 100 minutes** at the write limit, and partners split the work across many connections to go faster, which is what the limit is meant to stop.
* **Batches cut that to 9.8 minutes** but hold gateway connections for seconds: 1.7 % of batches timed out, and other partners' p99 doubled during the run.
* **Import jobs finish in 2.1 minutes.** Workers apply 480 inventory rows or 455 price rows per second; full product rows are slower at 310 per second because each one is validated against the category rules.
* Import jobs leave no trace in gateway latency: the only API calls are creating the job, uploading to object storage and reading the result.

## Recommendation

Do not add synchronous batch endpoints. Build asynchronous import jobs with one error report per job ([SPEC-041](@SPEC-041)), and point partners with more than a few hundred changes at a time to them ([SPEC-038](@SPEC-038)).

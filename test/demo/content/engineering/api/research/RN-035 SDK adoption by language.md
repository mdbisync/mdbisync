| Status | Complete |
| -- | -- |
| Date | 2026-04-28 |
| Authors | DemoJudy, DemoMike |
| Led to | [SPEC-044 SDK conventions](@SPEC-044) version 2.1 |

## Question

Three months after the SDKs for TypeScript, Python and Go reached 2.0 ([RFC-035](@RFC-035)), how much partner traffic goes through them, and is there a case for a Java or PHP SDK?

## Method

* All v2 calls from 2026-01-01 to 2026-04-26, classified by `User-Agent`. The SDKs send `demomart-ts/2.x`, `demomart-python/2.x` and `demomart-go/2.x`; other clients were grouped by the runtime their user agent names.
* Retry behaviour compared between SDK and non-SDK traffic: share of `429` responses followed by a retry within less than the `Retry-After` value.
* Time from first API key to first order for partners that started in the period.

## Results

@@picture:rn-035-share@@

@@table:rn-035-share@@

@@picture:rn-035-languages@@

@@table:rn-035-languages@@

@@csv:rn-035-languages@@

| Measure | Through an SDK | Own code |
| -- | -- | -- |
| Retries before `Retry-After` elapsed | 0.2 % | 31 % |
| Mutating calls with an `Idempotency-Key` reused on retry | 100 % | 74 % |
| Median days from first key to first order | 3 | 9 |

## Findings

* **64 % of v2 calls now go through an SDK**, up from 18 % in January. The jump in February follows the code samples in the API reference switching to the SDKs.
* **TypeScript leads** with 34 % of calls, then Python with 21 % and Go with 9 %.
* **Java and PHP stay small**: 6 % and 5 % of calls, each from fewer than 40 partners. Neither reaches the 10 % we set as the bar for a new SDK.
* **SDK traffic behaves better.** It almost never retries before `Retry-After` and always reuses its idempotency key, which own code gets wrong a quarter of the time.
* New partners on an SDK reach their first order in a median of 3 days, against 9 for those writing their own HTTP code.

## Recommendation

* No new SDK languages for now; check again in October 2026.
* Make the SDKs read the `RateLimit` headers and slow down before a `429` (done in [SPEC-044](@SPEC-044) version 2.1).
* Link the SDK first in every quick start of the API reference ([SPEC-030](@SPEC-030)).

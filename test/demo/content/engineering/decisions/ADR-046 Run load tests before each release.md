| Status | Accepted |
| -- | -- |
| Date | 2026-08-27 |
| Authors | DemoKen |
| Reviewers | DemoMike, DemoFrank |

## Context

Two performance regressions reached production in 2026: an N+1 query in the cart page in March and an unbounded list in the order API in July. Both passed every functional test and showed up only under sale traffic. Load tests exist, but they run by hand before big sales, about four times a year.

## Decision

Every release of a customer-facing service passes an **automated load test** in the pipeline's staging stage ([SPEC-003](@SPEC-003)).

* Tool: k6, with scenarios kept next to each service's code.
* Each scenario replays a recorded traffic mix at 1.5 times last month's peak for 10 minutes.
* The stage fails if p95 latency rises by more than 15 % or the error rate exceeds 0.5 % compared with the last release.
* Staging runs at a quarter of production size; thresholds are scaled accordingly.

```js
export const options = {
  scenarios: {
    browse: { executor: "constant-arrival-rate", rate: 900, timeUnit: "1s", duration: "10m", preAllocatedVUs: 300 },
  },
  thresholds: {
    http_req_failed: ["rate<0.005"],
    "http_req_duration{scenario:browse}": ["p(95)<450"],
  },
};
```

@@picture:adr-046-pipeline@@

## Options considered

| Option | Regressions caught (replay of 2026) | Added pipeline time | Cost | Verdict |
| -- | -- | -- | -- | -- |
| **Load test on every release** | **2 of 2** | **12 min** | **about 600 USD a month** | **Chosen** |
| Nightly load test on `main` | 2 of 2, a day late | none | about 300 USD | Regression already deployed by then |
| Before big sales only (today) | 0 of 2 | none | low | The problem we have |

## Consequences

* Releases take 12 minutes longer; the canary stage still follows ([RFC-001](@RFC-001)).
* Teams maintain their scenarios; stale scenarios are flagged when they cover less than 70 % of real endpoints.

## Follow-up

- [X] k6 stage in the pipeline
- [X] Scenarios for the web shop, checkout, search and the public API
- [ ] Scenarios for Seller Hub

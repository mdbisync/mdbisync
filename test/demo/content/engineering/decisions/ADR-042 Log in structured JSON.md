| Status | Accepted |
| -- | -- |
| Date | 2026-07-04 |
| Authors | DemoKen |
| Reviewers | DemoBob, DemoDave |
| Specification | [SPEC-004 Log record format](@SPEC-004) |
| Evidence | [RN-009 Log volume by service and level](@RN-009) |

## Context

Since [ADR-010](@ADR-010) logs flow through OpenTelemetry, but their content is still free text in five formats. Searching for one order's logs needs a different regular expression per service, log-based alerts break when wording changes, and [RN-009](@RN-009) found that 62 % of log volume is debug output left on in production.

## Decision

Services log **one JSON object per line** in the format of [SPEC-004](@SPEC-004), through the Go kit's logger.

* Required fields: `time`, `level`, `msg`, `service`, `trace_id`, `span_id`; domain identifiers use fixed names (`order_id`, `seller_id`).
* Levels: `debug` is off in production by default and can be turned on per service for 30 minutes.
* No personal data in logs; the logger drops fields named in a deny list and masks values that look like card numbers.
* Log-based alerts are replaced by metrics wherever possible.

```json
{"time":"2026-07-04T09:12:44.518Z","level":"warn","msg":"payment retry scheduled","service":"demo-pay","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7","order_id":"ord_81f2","attempt":2,"delay_ms":4000}
```

## Options considered

| Option | Query one order's logs across services | Log volume | Effort | Verdict |
| -- | -- | -- | -- | -- |
| **Structured JSON with fixed field names** | **one filter** | **about 40 % of today** | **logger change in the kit** | **Chosen** |
| Logfmt | one filter | similar | similar | Nested values are awkward |
| Parse free text in the collector | regular expressions per service | unchanged | high upkeep | Breaks with every wording change |

## Consequences

* Logs can be filtered and aggregated by field in every tool.
* Lines are longer; the volume still falls because debug logs are off.

## Follow-up

- [X] JSON logger in the Go kit
- [X] Personal data deny list
- [ ] Node.js services on the same format

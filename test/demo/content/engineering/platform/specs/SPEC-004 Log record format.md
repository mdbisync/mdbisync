| Status | Stable |
| -- | -- |
| Version | 1.4 |
| Updated | 2026-07-21 |
| Owner | DemoGrace |
| Applies to | Every service and job |

## Overview

Services write one JSON object per line to standard output ([ADR-042](@ADR-042)). The collector adds Kubernetes metadata and ships records to the log store. This specification fixes the field names so that a query works across all services.

## Fields

| Field | Type | Required | Example | Notes |
| -- | -- | -- | -- | -- |
| `ts` | RFC 3339 timestamp, UTC, milliseconds | yes | `2026-09-14T08:15:02.481Z` | |
| `level` | `debug`, `info`, `warn`, `error` | yes | `warn` | `debug` off in production |
| `msg` | string | yes | `payment declined` | Constant text; values go in fields |
| `service` | string | yes | `checkout-svc` | From the manifest |
| `version` | string | yes | `2026.09.14-3` | Image version |
| `trace_id` | 32 hex characters | when in a request | `4bf92f3577b34da6a3ce929d0e0e4736` | [SPEC-005](@SPEC-005) |
| `span_id` | 16 hex characters | when in a request | `00f067aa0ba902b7` | |
| `error` | string | for `error` level | `context deadline exceeded` | |
| `duration_ms` | number | for timed operations | `412` | |

Other fields use `snake_case` and are free per service. Field names starting with `k8s_` are reserved for the collector.

## Example

```json
{"ts":"2026-09-14T08:15:02.481Z","level":"warn","msg":"payment declined","service":"checkout-svc","version":"2026.09.14-3","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7","order_id":"ord_01J8Z3","decline_code":"insufficient_funds","attempt":2}
```

## What never goes into a log

| Data | Rule |
| -- | -- |
| Card numbers, security codes | Never; `demo-pay` never sees them in plain form |
| Passwords, tokens, API keys | Never; the logger masks fields named `password`, `token`, `secret`, `authorization` |
| Names, addresses, phone numbers | Never; log the account id instead ([ADR-028](@ADR-028)) |
| Request and response bodies | Only in `debug`, which is off in production |

## Levels

| Level | Use for | Volume guide |
| -- | -- | -- |
| `error` | A request or job failed and someone may need to act | Alerts may fire on rate |
| `warn` | Something unusual that the service handled | |
| `info` | One record per request at most, plus lifecycle events | Most volume |
| `debug` | Details for local work | Off in production |

[RN-009](@RN-009) found that `info` records from three services made up 61 % of all log volume; those services now sample request logs at 10 %.

## Limits

| Limit | Value | Over the limit |
| -- | -- | -- |
| Record size | 16 KB | Truncated, with `truncated: true` |
| Records per pod per second | 500 | Dropped, with a counter metric |
| Retention | 30 days, 13 months for `error` | |

## Version history

| Version | Date | Change |
| -- | -- | -- |
| 1.0 | 2025-06-17 | First version |
| 1.2 | 2025-10-07 | Reserved `k8s_` prefix |
| 1.3 | 2026-02-03 | Masked field names |
| 1.4 | 2026-07-21 | Per-pod rate limit |

## Related

* [ADR-042 Log in structured JSON](@ADR-042)
* [SPEC-005 Trace context propagation](@SPEC-005)

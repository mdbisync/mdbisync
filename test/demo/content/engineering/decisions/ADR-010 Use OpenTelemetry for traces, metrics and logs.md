| Status | Accepted |
| -- | -- |
| Date | 2025-04-27 |
| Authors | DemoKen |
| Reviewers | DemoBob, DemoDave |

## Context

Each service reports telemetry its own way: two vendor agents, a Prometheus client in Go services, and plain text logs. A slow checkout cannot be followed across services, because only four of twelve services propagate a trace id. Switching vendors would mean changing code in every service.

## Decision

All services emit traces, metrics and logs through **OpenTelemetry** SDKs, to an OpenTelemetry Collector in each cluster. The collector decides where data goes.

* Trace context is W3C `traceparent` ([SPEC-005](@SPEC-005)); metric names follow [SPEC-006](@SPEC-006); logs follow [SPEC-004](@SPEC-004) and [ADR-042](@ADR-042).
* Head sampling at 10 % for traces, 100 % for errors and slow requests (tail sampling in the collector); see [RN-010](@RN-010).
* The Go kit ([ADR-003](@ADR-003)) sets everything up; a service writes no telemetry setup code.

```yaml
processors:
  tail_sampling:
    policies:
      - name: errors
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow
        type: latency
        latency: { threshold_ms: 1500 }
      - name: rest
        type: probabilistic
        probabilistic: { sampling_percentage: 10 }
```

## Options considered

| Option | Vendor lock-in | Services to change on a vendor switch | Trace coverage | Verdict |
| -- | -- | -- | -- | -- |
| **OpenTelemetry SDKs and Collector** | **none** | **0** | **all services** | **Chosen** |
| One vendor's agents everywhere | high | 12 | all services | Expensive to leave |
| Prometheus and Jaeger clients | low | 0 | all services | Two SDKs instead of one; logs not covered |
| Keep today's mix | mixed | 12 | 4 of 12 | The problem we have |

## Consequences

* One trace follows a request from the edge to the database.
* The collector is a new component per cluster; it runs as a DaemonSet plus a gateway deployment.
* Telemetry storage costs are visible per service ([RN-010](@RN-010)).

## Follow-up

- [X] Collector in every cluster
- [X] Go kit emits OpenTelemetry
- [ ] Node.js web shop and `notify-svc` on the OpenTelemetry SDK

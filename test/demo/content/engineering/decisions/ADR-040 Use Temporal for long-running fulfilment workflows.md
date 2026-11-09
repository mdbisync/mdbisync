| Status | Accepted |
| -- | -- |
| Date | 2026-06-07 |
| Authors | DemoOscar |
| Reviewers | DemoMike, DemoFrank |
| Reviewed in | [ADR-050 Keep Temporal for fulfilment after the 2026 review](@ADR-050) |

## Context

Fulfilment of a multi-seller order takes days: each seller confirms, ships and hands over to a carrier; parts can be cancelled or returned. `fulfilment-svc` tracks this with status columns, 14 cron jobs and timers in Redis. When a carrier's API failed for six hours in May, 1,300 shipments got stuck and had to be pushed on by hand, because retries were coded differently in every step.

## Decision

Long-running fulfilment processes run as **Temporal workflows**, on a self-hosted Temporal cluster.

* One workflow per seller shipment: wait for confirmation, wait for label, hand over, track until delivered or returned.
* Activities call other services; retries, timeouts and backoff are declared per activity, not hand-coded.
* Timers (seller confirmation deadline of 48 hours, delivery tracking every 6 hours) are workflow timers.
* The order's status still belongs to `orders-svc` ([ADR-021](@ADR-021)); workflows ask it to transition.

```go
func ShipmentWorkflow(ctx workflow.Context, in ShipmentInput) error {
    ao := workflow.ActivityOptions{
        StartToCloseTimeout: 30 * time.Second,
        RetryPolicy: &temporal.RetryPolicy{MaximumAttempts: 0, MaximumInterval: 10 * time.Minute},
    }
    ctx = workflow.WithActivityOptions(ctx, ao)
    if err := awaitSellerConfirmation(ctx, in, 48*time.Hour); err != nil {
        return cancelShipment(ctx, in)
    }
    return workflow.ExecuteActivity(ctx, BuyLabel, in).Get(ctx, nil)
}
```

## Options considered

| Option | Stuck shipments after the May outage (replay) | Lines of retry and timer code | New components | Verdict |
| -- | -- | -- | -- | -- |
| **Temporal workflows** | **0, resumed automatically** | **about 300** | **Temporal cluster** | **Chosen** |
| Step functions of the cloud provider | 0 | about 500 | none | Workflows in JSON, hard to test |
| Choreography over Kafka with sagas | some, needs compensation code | about 2,000 | none | Timers and deadlines are awkward |
| Status columns and cron jobs (today) | 1,300 | about 4,500 | none | The problem we have |

## Consequences

* Fulfilment logic reads as straight-line code, with its retries visible.
* Temporal is a new system to run: a cluster with its own PostgreSQL database.
* The decision is reviewed after a year of operation ([ADR-050](@ADR-050)).

## Follow-up

- [X] Temporal cluster in both regions
- [X] Shipment workflow for new orders
- [X] Drain the old cron-based path

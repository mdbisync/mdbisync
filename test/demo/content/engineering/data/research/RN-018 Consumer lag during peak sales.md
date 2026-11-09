| Status | Complete |
| -- | -- |
| Date | 2025-12-03 |
| Authors | DemoIvan |
| Led to | Partition rule in [SPEC-021](@SPEC-021) version 2.0 and consumer autoscaling |

## Question

How far did Kafka consumers fall behind during the November 2025 sale, which of them, and why?

## Method

* Consumer lag in seconds (age of the oldest unprocessed event) per consumer group, from the broker metrics, every minute from 18:00 to 02:00 on the sale night, 2025-11-28.
* The three consumer groups with the most traffic: `notify-svc`, `fulfilment-svc` and `events-pipeline`.
* Pod counts, CPU and calls to dependencies from the platform dashboards for the same window.
* The chart shows the hourly maximum.

## Results

@@picture:rn-018-lag@@

@@table:rn-018-lag@@

@@csv:rn-018-lag@@

## Findings

* Order events peaked at 9,000 per second at 21:00, five times a normal evening.
* `events-pipeline` fell 95 s behind at 21:00. Its pods were at their limit of 24, one per partition of `orders.events` at the time; more pods would have stayed idle.
* `notify-svc` reached 48 s of lag. The cause was not Kafka: its email template service answered in 1.8 s instead of 120 ms, and each consumer waited.
* `fulfilment-svc` never passed 9 s: it does little work per event.
* All consumers were back under 2 s by 01:00, without intervention.

> [!NOTE]
> A consumer can never have more active pods than its topic has partitions. Partition counts must be sized for peak, not for the average.

## Recommendation

* Raise `orders.events` from 24 to 48 partitions, and size every new domain event topic by its expected peak ([SPEC-021](@SPEC-021)).
* Scale consumers on lag, not on CPU: `events-pipeline` sat at 55 % CPU while 95 s behind.
* `notify-svc` calls its template service with a timeout of 500 ms and parks the message on failure ([RFC-028](@RFC-028)) instead of waiting.

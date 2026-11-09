| Status | Complete |
| -- | -- |
| Date | 2025-01-28 |
| Authors | DemoFrank, DemoGrace |
| Led to | [ADR-003 Use Go for backend services](@ADR-003) |

## Question

Which language runtime lets a new pod serve its first request fastest and with the least memory, so that autoscaling reacts quickly and small services stay cheap?

## Method

* The same small HTTP service (one JSON endpoint that reads from PostgreSQL) written in five runtimes.
* Container limit 512 MB, 0.5 CPU, on the same node type.
* Cold start: from container start to the first successful response; 200 starts each, median reported.
* Memory: resident set size at idle after 5 minutes, and after 10 minutes at 200 requests per second.

## Results

@@picture:rn-002-cold-start@@

@@table:rn-002-cold-start@@

@@picture:rn-002-memory@@

@@table:rn-002-memory@@

@@csv:rn-002-memory@@

## Findings

* Go starts in 41 ms and needs 14 MB at idle. Java with the JIT compiler needs 1,240 ms and 210 MB, though it reaches the same throughput after warm-up.
* A Java native image closes most of the gap (96 ms) but its build takes 6 minutes per service and some libraries need extra configuration.
* Node.js is a reasonable middle ground and stays the choice for the web shop, which already uses it ([ADR-023](@ADR-023)).
* Start time matters most for request-rate autoscaling during sales ([RN-005](@RN-005)); memory matters for cost, since most services idle at night.

## Recommendation

Write new backend services in Go. Keep Node.js for the web shop. Do not start new JVM services.

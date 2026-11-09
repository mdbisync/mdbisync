| Status | Complete |
| -- | -- |
| Date | 2026-05-26 |
| Authors | DemoNina, DemoErin |
| Follows | [RFC-003 Autoscaling services on request rate](@RFC-003) |

## Question

How well do our pods fill the nodes they run on, and how much would right-sizing CPU and memory requests save?

## Method

* Node and pod metrics for every weekday of May 2026, 5-minute resolution.
* Requested: the sum of pod requests over allocatable capacity. Used: actual usage over allocatable capacity.
* For each service, the p95 of actual CPU and memory compared with its request.

## Results

@@picture:rn-012-packing@@

@@table:rn-012-packing@@

@@csv:rn-012-packing@@

| Service group | Services | CPU request over p95 use | Memory request over p95 use |
| -- | -- | -- | -- |
| Overprovisioned by more than 2 times | 5 | 2.6 times | 1.9 times |
| Within 1.2 to 2 times | 6 | 1.5 times | 1.4 times |
| Tight, under 1.2 times | 1 | 1.1 times | 1.2 times |

## Findings

* The general pool is 72 % requested but only 41 % used: nodes are full on paper and half idle in practice.
* Five services request more than twice the CPU they use at p95, mostly set when they were created and never revisited.
* Batch and CI pools are tighter because their jobs are short and sized from recent runs.
* Right-sizing the five services to 1.3 times their p95 use would free about 9 nodes in the general pool, about 6,200 USD a month.

## Recommendation

Show request against p95 use in the service manifest's generated dashboard ([SPEC-001](@SPEC-001)), right-size the five services, and review requests together with each load test.

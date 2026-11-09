| Status | Complete |
| -- | -- |
| Date | 2025-12-03 |
| Authors | DemoOscar, DemoKen |
| Led to | Two more data nodes before the next sales week; [SPEC-059](@SPEC-059) budget unchanged |

## Question

The search cluster met its p99 budget of 200 ms ([SPEC-059](@SPEC-059)) on normal days. Did it hold on the busiest day of the year, the Friday of the November sales week, when traffic reached 3.4 times the daily average?

## Method

* Search-svc and OpenSearch metrics for Friday 2025-11-28, 06:00 to 23:00 UTC, in 1-minute resolution, aggregated to two-hour points for the chart.
* Learning to rank was already on for 50 % of traffic ([RN-054](@RN-054)); latencies below include re-ranking where it applied.
* Cluster: 6 data nodes, 3 primary shards with 2 replicas for the product index of 3.0 million listings.

## Results

@@picture:rn-059-latency@@

@@table:rn-059-latency@@

@@csv:rn-059-latency@@

## Findings

* p99 crossed 200 ms twice: at the 10:00 point (212 ms) and at the 20:00 point (241 ms), when traffic peaked at 1,940 searches per second.
* The cause both times was search thread-pool queueing on the two nodes that also held the busiest replica of shard 2. CPU there reached 92 % while the other four nodes stayed below 70 %.
* p50 barely moved (31 to 44 ms): most searches were fast, and the slow tail came from queueing, not from slow queries.
* No search failed. 0.02 % of requests hit the 2-second timeout and returned partial results.

## Recommendation

* Add two data nodes and move to 4 primary shards so hot shards spread over more nodes; repeat the replay load test of [ADR-046](@ADR-046) at 2,500 searches per second before the next sales week.
* Cache the 1,000 most frequent queries for 30 seconds in search-svc; they were 38 % of searches at the peak.

| Status | Complete |
| -- | -- |
| Date | 2026-04-14 |
| Authors | DemoNina |
| Led to | [RFC-014 Spot instances for batch workloads](@RFC-014) |

## Question

How often are spot instances reclaimed in our region, which instance types are safest, and what does an interruption cost a CI job or a batch job?

## Method

* Interruption notices from the `ci` spot pool and a trial `batch-spot` pool, 1 January to 31 March 2026.
* 64,000 node hours across six instance types.
* For each interrupted job: whether it finished after a restart, and how much time the restart added.

## Results

@@picture:rn-007-interruptions@@

@@table:rn-007-interruptions@@

@@csv:rn-007-interruptions@@

| Workload | Jobs | Interrupted | Finished after restart | Median time added |
| -- | -- | -- | -- | -- |
| CI jobs | 57,200 | 0.6 % | 99.7 % | 3 min |
| Batch jobs (trial) | 1,840 | 2.3 % | 98.1 % | 11 min |

## Findings

* Smaller and memory-optimised types were reclaimed least; large compute types most, probably because other customers want them too.
* With six types in one pool, there was never a moment when all six were reclaimed together.
* Batch jobs that failed after a restart did not save progress; they started over and ran past their window.
* Spot prices were 31 to 38 % of on-demand prices for these types over the quarter.

## Recommendation

Use spot for CI and batch with at least four instance types per pool, prefer general and memory types, and require batch jobs to save progress every 5 minutes as [RFC-014](@RFC-014) proposes.

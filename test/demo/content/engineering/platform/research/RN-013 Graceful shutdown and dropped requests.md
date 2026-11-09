| Status | Complete |
| -- | -- |
| Date | 2025-06-10 |
| Authors | DemoGrace |
| Led to | [RFC-010 Graceful shutdown for all services](@RFC-010) |

## Question

How many requests and events do we lose each time pods restart during a deploy, and does an ordered shutdown remove the loss?

## Method

* First measurement: every deploy of four services in March 2025, 61 deploys.
* Second measurement: every deploy of the same services in June 2025, after [RFC-010](@RFC-010), 58 deploys.
* Failed requests: connection errors and 502 responses at the load balancer within 60 seconds of a pod receiving SIGTERM.
* Reprocessed events: events a consumer handled twice after a restart, from the consumers' deduplication counters.

## Results

@@picture:rn-013-dropped@@

@@table:rn-013-dropped@@

@@csv:rn-013-dropped@@

| Measure | March 2025 | June 2025 |
| -- | -- | -- |
| Events reprocessed per consumer restart, median | 310 | 0 |
| Events reprocessed per consumer restart, maximum | 500 | 12 |
| Time from SIGTERM to exit, median | 0.4 s | 9.8 s |

## Findings

* Before, pods exited immediately while the load balancer kept routing to them for several seconds; each deploy failed between 41 and 112 requests per service.
* After, the 5-second wait before closing listeners removed almost all failures. The few left in `search-svc` are requests longer than 15 seconds (large exports).
* Committing offsets before stopping consumers ended the reprocessing of whole batches.
* Deploys take about 10 seconds longer per pod; with canaries this is invisible.

## Recommendation

Keep the shutdown order in the service template ([RFC-002](@RFC-002)). Move large exports to a resumable cursor so no request runs longer than the shutdown window.

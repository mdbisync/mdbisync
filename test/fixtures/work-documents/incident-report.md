# Incident review: slow search

**Impact:** search took over ten seconds for 40 minutes.

## Timeline

| Time | Event |
| -- | -- |
| 09:12 | Alert fired |
| 09:20 | Index rebuild found running |
| 09:52 | Rebuild paused, latency normal |

## Root cause

A scheduled index rebuild ran during peak hours.

## Follow-ups

* [ ] Move rebuilds to the night window
* [ ] Alert on rebuild duration

Ref kx-55d16289
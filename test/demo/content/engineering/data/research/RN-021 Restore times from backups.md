| Status | Complete |
| -- | -- |
| Date | 2026-10-12 |
| Authors | DemoMike |
| Led to | Expected durations in [SPEC-026 Backup and restore procedure](@SPEC-026) |

## Question

How long does a point-in-time restore take for each database, and does it still meet the recovery time objectives of [SPEC-026](@SPEC-026) as the databases grow?

## Method

* Twelve monthly automated drills, November 2025 to October 2026, set up by [RFC-021](@RFC-021). Each restored one database to a random point of the last 14 days into a scratch cluster.
* Every database was drilled at least twice; for the chart by database we used the latest drill of each.
* Restore time split into the full-backup restore and the WAL replay up to the target, normalised to 24 hours of WAL.
* The restore was checked with row counts and checksums of the 20 largest tables.

## Results

@@picture:rn-021-by-database@@

@@table:rn-021-by-database@@

@@picture:rn-021-trend@@

@@table:rn-021-trend@@

@@csv:rn-021-trend@@

## Findings

* All restores met their objectives: orders, the largest at 430 GB, took 53 minutes against an objective of 60.
* Orders is the database to watch. Its restore time went from 58 minutes in November 2025 down to 50 minutes in April 2026, after the old order rows moved out with monthly partitions ([RFC-019](@RFC-019)), and has grown back to 53 minutes since.
* At the current growth of about half a minute a month, orders will pass 60 minutes in a little over a year.
* WAL replay is a quarter of the total for orders: busy days produce more WAL than the differential backups absorb.
* All 12 drills passed their checks. Two needed a manual step: the scratch cluster ran out of disk once, and once the target time fell before the oldest kept backup.

## Recommendation

* Restore orders with 16 parallel processes instead of 8 (`process-max`), which cut 9 minutes in a trial run.
* Take differential backups of orders every 30 minutes instead of hourly to shorten the WAL replay.
* Revisit in April 2027; if orders still trends past 60 minutes, split it by region.

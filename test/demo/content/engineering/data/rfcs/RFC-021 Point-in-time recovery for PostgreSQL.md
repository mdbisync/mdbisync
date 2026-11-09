| Status | Implemented |
| -- | -- |
| Created | 2025-08-05 |
| Authors | DemoMike |
| Reviewers | DemoGrace, DemoKen |
| Target | Q4 2025 |
| Decision | none; procedure in [SPEC-026](@SPEC-026) |

## Summary

Archive PostgreSQL write-ahead log continuously to object storage with pgBackRest, keep daily full and hourly differential backups, and make it possible to restore any database to any second of the last 14 days.

## Motivation

Today each database has one nightly `pg_dump`, kept 7 days.

* The worst case loses 24 hours of orders. Our recovery point objective for checkout and orders is 5 minutes.
* Restoring the 410 GB orders database from a dump took 6 h 50 min in the March 2025 drill, against a recovery time objective of 2 hours.
* A bad migration on 2025-07-22 deleted 3,100 seller addresses; the only copy was 19 hours old.

## Proposal

### Backups

| Backup | Frequency | Kept | Stored in |
| -- | -- | -- | -- |
| Full | daily, 02:00 UTC | 14 days | object storage, same region |
| Differential | hourly | 14 days | object storage, same region |
| WAL segments | continuous, every 60 s at the latest | 14 days | object storage, same region |
| Full copy | weekly | 90 days | object storage, other region |

@@picture:rfc-021-backup@@

### Configuration

```ini
[global]
repo1-type=s3
repo1-s3-bucket=demomart-pg-backup
repo1-retention-full=14
repo1-cipher-type=aes-256-cbc
archive-async=y
process-max=8

[orders]
pg1-path=/var/lib/postgresql/16/main
```

`archive_timeout` is 60 seconds, so at most one minute of WAL is outside the archive.

### Restore drills

Every month an automated job restores one database to a random point of the last 14 days into a scratch cluster, runs row counts and checksums, and reports the duration. Results go into [RN-021](@RN-021).

## Alternatives

| Option | Recovery point | Restore of 410 GB | Why not |
| -- | -- | -- | -- |
| Nightly `pg_dump` (today) | 24 h | 6 h 50 min | Both objectives missed |
| Cloud disk snapshots | 1 h | 25 min | No point in time; consistency across volumes needs care |
| **pgBackRest with WAL archive** | **1 min** | **48 min** | Chosen |
| Delayed replica only | 1 h delay | minutes | Covers mistakes, not lost regions; we add it for orders only |

## Rollout

- [X] pgBackRest on the orders and payments clusters
- [X] All other clusters
- [X] Weekly copy to the second region
- [X] Monthly restore drill, first run 2025-11-03
- [X] Remove nightly dumps

## Open questions

* Do we keep 14 days or 30? 30 days doubles storage to about 9 TB; we revisit after a year of drills.

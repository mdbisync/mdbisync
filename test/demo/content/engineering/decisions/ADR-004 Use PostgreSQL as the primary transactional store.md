| Status | Implemented |
| -- | -- |
| Date | 2025-02-06 |
| Authors | DemoCarol |
| Reviewers | DemoIvan, DemoBob |

## Context

Transactional data lives in three engines: PostgreSQL 12 for orders and accounts, MySQL 5.7 for the catalog, and a document database for seller profiles. Backups, monitoring and on-call knowledge are split three ways, and MySQL 5.7 left support in October 2023. Joins across catalog and orders are done in application code.

## Decision

**PostgreSQL 16**, on the cloud provider's managed service, is the one engine for transactional data.

* Each service gets its own database ([ADR-015](@ADR-015)); a database never serves two services.
* Instances run with a synchronous standby in a second zone and point-in-time recovery ([RFC-021](@RFC-021)).
* Connections go through PgBouncer in transaction mode ([RFC-026](@RFC-026)).
* JSONB columns hold the few document-shaped fields, such as seller profile settings.

```sql
CREATE TABLE sellers (
    id          uuid PRIMARY KEY,
    display     text NOT NULL,
    country     char(2) NOT NULL,
    settings    jsonb NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sellers_settings_gin ON sellers USING gin (settings);
```

## Options considered

| Option | Engines to run | Supported until | Document fields | Verdict |
| -- | -- | -- | -- | -- |
| **PostgreSQL 16 only** | **1** | **2028-11** | **JSONB** | **Chosen** |
| MySQL 8 only | 1 | 2026-04 | JSON type, weaker indexing | Shorter support, no partial indexes |
| Keep three engines, upgrade MySQL | 3 | varies | native | Three sets of skills and backups |

## Consequences

* The catalog moves from MySQL in a planned migration of 38 million rows, with dual writes for two weeks.
* Seller profiles move into a JSONB column; the document database is switched off, saving about 900 USD a month.
* One backup procedure ([SPEC-026](@SPEC-026)) covers everything.

## Follow-up

- [X] Upgrade orders and accounts from PostgreSQL 12 to 16
- [X] Migrate the catalog from MySQL
- [X] Migrate seller profiles
- [X] Switch off MySQL and the document database

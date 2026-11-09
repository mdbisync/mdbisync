| Status | Complete |
| -- | -- |
| Date | 2025-04-28 |
| Authors | DemoMike |
| Led to | [RFC-026 Connection pooling with PgBouncer](@RFC-026) |

## Question

How much throughput do we gain by putting PgBouncer between services and PostgreSQL, and which pool mode should we use?

## Method

* `pgbench` with a custom script modelled on checkout: two selects, one insert and one update per transaction.
* PostgreSQL 16 on the production instance size, `max_connections = 1000`.
* Three setups: direct connections, PgBouncer in session mode, PgBouncer in transaction mode with a server pool of 60.
* 100, 250, 500 and 1,000 concurrent clients, 10 minutes each, after a 2-minute warm-up.
* Statement mode was left out: it breaks multi-statement transactions.

## Results

@@picture:rn-019-tps@@

@@table:rn-019-tps@@

@@csv:rn-019-tps@@

## Findings

* Up to 250 clients all setups are close; transaction mode is already 16 % faster than direct connections at 250.
* From 500 clients, direct connections and session mode degrade: each client holds a server connection, and PostgreSQL spends its time switching between 500 to 1,000 backends.
* At 1,000 clients transaction mode serves 11,600 transactions per second, 2.8 times session mode (4,100) and 3.0 times direct connections (3,900). Direct connections also returned errors at 1,000 clients: 0.6 % of attempts hit the connection limit.
* Transaction mode kept p99 latency at 31 ms at 1,000 clients; session mode reached 410 ms.

## Recommendation

Use PgBouncer in transaction mode in front of every primary, with a server pool of about 60 per database, and keep services free of session state. Proposed in [RFC-026](@RFC-026).

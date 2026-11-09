# Demo corpus catalog

Every document of the demo corpus, by folder. The folder's `README.md`
names its Linear team or project. A document's file name is
`<id> <title>.md` (for example `engineering/decisions/ADR-005 Use Kafka for
domain events.md`), and other documents link to it by id
(`[domain events](@ADR-005)`). Subfolders `rfcs/`, `specs/` and `research/`
become title paths in Linear (`rfcs/RFC-017 Change data capture with
Debezium`).

| Linear container | Folder | Documents |
| -- | -- | -- |
| Team Engineering (team zone) | `engineering/` | README and 3 |
| Project Architecture decisions | `engineering/decisions/` | README and 50 |
| Project Platform | `engineering/platform/` | README and 43 |
| Project Data and storage | `engineering/data/` | README and 42 |
| Project Public API | `engineering/api/` | README and 40 |
| Team Product (team zone) | `product/` | README and 2 |
| Project Checkout and payments | `product/checkout/` | README and 36 |
| Project Search and discovery | `product/search/` | README and 30 |
| Project Mobile app | `product/mobile/` | README and 27 |
| Project Seller Hub | `product/sellers/` | README and 25 |

## engineering/ (team zone)

- RFC process
- ADR template
- Technology radar 2026

## engineering/decisions/

- ADR-001 Record architecture decisions as Markdown files
- ADR-002 Run services on managed Kubernetes
- ADR-003 Use Go for backend services
- ADR-004 Use PostgreSQL as the primary transactional store
- ADR-005 Use Kafka for domain events
- ADR-006 Use gRPC between internal services
- ADR-007 Expose a REST API with OpenAPI 3.1 to partners
- ADR-008 Deploy with Argo CD from one environments repository
- ADR-009 Manage cloud resources with Terraform
- ADR-010 Use OpenTelemetry for traces, metrics and logs
- ADR-011 Store analytics events in ClickHouse
- ADR-012 Use OpenSearch for product search
- ADR-013 Use Redis for carts and short-lived sessions
- ADR-014 Publish events through a transactional outbox
- ADR-015 Give each service its own database
- ADR-016 Version the public API in the URL path
- ADR-017 Authenticate partners with OAuth 2.0 client credentials
- ADR-018 Sign webhooks with HMAC-SHA256
- ADR-019 Require idempotency keys on mutating API calls
- ADR-020 Store money as integer minor units with a currency code
- ADR-021 Keep the order state machine in orders-svc
- ADR-022 Ship every user-facing change behind a feature flag
- ADR-023 Build the web shop with Next.js and server rendering
- ADR-024 Build the mobile app natively in Kotlin and Swift
- ADR-025 Share design tokens between web and app
- ADR-026 Use Protobuf event payloads with a schema registry
- ADR-027 Retain raw events for 13 months
- ADR-028 Encrypt personal data at the field level
- ADR-029 Run batch jobs as Kubernetes CronJobs
- ADR-030 Keep backend services in one monorepo
- ADR-031 Replace self-hosted CI runners with ephemeral runners
- ADR-032 Adopt trunk-based development
- ADR-033 Set service level objectives for customer-facing services
- ADR-034 Use a token bucket for API rate limits
- ADR-035 Cache product pages at the edge for 60 seconds
- ADR-036 Feed the search index from change data capture
- ADR-037 Partition the orders table by month
- ADR-038 Route all payments through one payment orchestrator
- ADR-039 Send all notifications through notify-svc
- ADR-040 Use Temporal for long-running fulfilment workflows
- ADR-041 Serve images from a CDN with on-the-fly resizing
- ADR-042 Log in structured JSON
- ADR-043 Use schema-first GraphQL for Seller Hub
- ADR-044 Retire public API v1 by June 2026
- ADR-045 Use vector search for similar products
- ADR-046 Run load tests before each release
- ADR-047 Keep secrets in a managed secret store
- ADR-048 Run checkout active-passive across two regions
- ADR-049 Replace nightly reconciliation with streaming reconciliation
- ADR-050 Keep Temporal for fulfilment after the 2026 review

## engineering/platform/

rfcs/

- RFC-001 Progressive delivery with canary releases
- RFC-002 A shared service template for Go services
- RFC-003 Autoscaling services on request rate
- RFC-004 Moving CI to ephemeral runners
- RFC-005 A service mesh for mutual TLS
- RFC-006 Cost allocation labels for every workload
- RFC-007 Preview environments for pull requests
- RFC-008 Standard health and readiness endpoints
- RFC-009 Error budgets and release freezes
- RFC-010 Graceful shutdown for all services
- RFC-011 A golden path for new services
- RFC-012 Typed configuration for services
- RFC-013 Smaller container images
- RFC-014 Spot instances for batch workloads
- RFC-015 Multi-region failover for checkout

specs/

- SPEC-001 Service manifest format
- SPEC-002 Health check endpoints
- SPEC-003 Deployment pipeline stages
- SPEC-004 Log record format
- SPEC-005 Trace context propagation
- SPEC-006 Metric naming conventions
- SPEC-007 Alert rule format
- SPEC-008 Service level objective definitions
- SPEC-009 Feature flag evaluation API
- SPEC-010 Secret rotation protocol
- SPEC-011 Container image labels
- SPEC-012 Canary analysis metrics
- SPEC-013 Preview environment lifecycle
- SPEC-014 Cost allocation labels

research/

- RN-001 Canary analysis on six months of releases
- RN-002 Cold start times of service runtimes
- RN-003 CI pipeline duration before and after ephemeral runners
- RN-004 Service mesh latency overhead
- RN-005 Autoscaling on CPU versus request rate
- RN-006 Container image sizes across services
- RN-007 Spot instance interruption rates
- RN-008 Cost per request by service
- RN-009 Log volume by service and level
- RN-010 Trace sampling rates and storage cost
- RN-011 Deployment frequency and change failure rate
- RN-012 Node pool bin packing efficiency
- RN-013 Graceful shutdown and dropped requests
- RN-014 Failover drill results for checkout

## engineering/data/

rfcs/

- RFC-016 Splitting the shared database by service
- RFC-017 Change data capture with Debezium
- RFC-018 A schema registry for event payloads
- RFC-019 Monthly partitions for the orders table
- RFC-020 Moving analytics events to ClickHouse
- RFC-021 Point-in-time recovery for PostgreSQL
- RFC-022 Read replicas for catalog reads
- RFC-023 A retention policy for raw events
- RFC-024 Exactly-once processing in the events pipeline
- RFC-025 Streaming reconciliation of payments and orders
- RFC-026 Connection pooling with PgBouncer
- RFC-027 Backfilling events after schema changes
- RFC-028 A dead letter topic for every consumer
- RFC-029 Field-level encryption for personal data

specs/

- SPEC-016 Domain event envelope
- SPEC-017 Order events
- SPEC-018 Product events
- SPEC-019 Payment events
- SPEC-020 Analytics event schema
- SPEC-021 Kafka topic naming and configuration
- SPEC-022 Outbox table layout
- SPEC-023 Orders database schema
- SPEC-024 Catalog database schema
- SPEC-025 ClickHouse events table
- SPEC-026 Backup and restore procedure
- SPEC-027 Data retention periods
- SPEC-028 Dead letter message format
- SPEC-029 Encryption key hierarchy

research/

- RN-015 Kafka versus NATS JetStream for domain events
- RN-016 Partitioning the orders table in PostgreSQL
- RN-017 ClickHouse compression codecs for event data
- RN-018 Consumer lag during peak sales
- RN-019 PgBouncer pool modes under load
- RN-020 Debezium replication lag
- RN-021 Restore times from backups
- RN-022 Read replica lag and stale reads
- RN-023 Storage growth forecast for 2027
- RN-024 Event payload sizes in Protobuf and JSON
- RN-025 ClickHouse query latency by table layout
- RN-026 Outbox polling versus log tailing
- RN-027 Dead letter volumes by consumer
- RN-028 Cost of field-level encryption

## engineering/api/

rfcs/

- RFC-030 Public API v2
- RFC-031 Webhooks with retries and signatures
- RFC-032 Cursor pagination for list endpoints
- RFC-033 Rate limits per partner and endpoint
- RFC-034 Idempotency keys for mutating requests
- RFC-035 Generated SDKs for TypeScript, Python and Go
- RFC-036 A sandbox environment for partners
- RFC-037 Deprecation policy for API versions
- RFC-038 Bulk endpoints for catalog updates
- RFC-039 Problem details for API errors
- RFC-040 OAuth scopes for partner apps
- RFC-041 An API changelog generated from the OpenAPI document
- RFC-042 Webhook event replay

specs/

- SPEC-030 Public API overview
- SPEC-031 Authentication and scopes
- SPEC-032 Errors
- SPEC-033 Pagination
- SPEC-034 Rate limit headers
- SPEC-035 Idempotency
- SPEC-036 Products endpoints
- SPEC-037 Orders endpoints
- SPEC-038 Inventory endpoints
- SPEC-039 Webhook delivery
- SPEC-040 Webhook event types
- SPEC-041 Bulk catalog import
- SPEC-042 Versioning and deprecation headers
- SPEC-043 Sandbox environment
- SPEC-044 SDK conventions

research/

- RN-029 Partner API usage by endpoint
- RN-030 Webhook delivery success and retry timing
- RN-031 Offset versus cursor pagination performance
- RN-032 Rate limit algorithms compared
- RN-033 Error rates by API version
- RN-034 Bulk import throughput
- RN-035 SDK adoption by language
- RN-036 API gateway latency overhead
- RN-037 Duplicate requests without idempotency keys
- RN-038 Migration from v1 to v2
- RN-039 Payload compression for list endpoints
- RN-040 Webhook signature checks in partner code

## product/ (team zone)

- Specification template
- Glossary

## product/checkout/

rfcs/

- RFC-043 One-page checkout
- RFC-044 Saved payment methods
- RFC-045 Guest checkout
- RFC-046 Split shipments for multi-seller carts
- RFC-047 Address autocomplete
- RFC-048 Buy now, pay later as a payment method
- RFC-049 3-D Secure 2 for card payments
- RFC-050 Payment retries for soft declines
- RFC-051 Tax calculation at checkout
- RFC-052 Stock reservation in the cart
- RFC-053 Self-service refunds
- RFC-054 Local currency display for cross-border buyers

specs/

- SPEC-045 Checkout flow
- SPEC-046 Cart data model
- SPEC-047 Order state machine
- SPEC-048 Payment intents
- SPEC-049 Payment method types
- SPEC-050 Refunds
- SPEC-051 Shipping options
- SPEC-052 Tax lines
- SPEC-053 Promotions and vouchers
- SPEC-054 Stock reservation
- SPEC-055 Order confirmation email
- SPEC-056 Fraud checks
- SPEC-057 Seller payouts
- SPEC-058 Currency conversion

research/

- RN-041 Checkout drop-off by step
- RN-042 One-page checkout experiment results
- RN-043 Payment method mix by country
- RN-044 Soft decline recovery with retries
- RN-045 3-D Secure challenge rates
- RN-046 Address autocomplete and failed deliveries
- RN-047 Guest checkout conversion
- RN-048 Cart abandonment by device
- RN-049 Fraud check false positives
- RN-050 Refund processing times

## product/search/

rfcs/

- RFC-055 Typo tolerance in product search
- RFC-056 Facets on category pages
- RFC-057 Learning to rank for search results
- RFC-058 Synonyms managed by merchandisers
- RFC-059 Similar products with vector search
- RFC-060 Search suggestions as you type
- RFC-061 Personalised ranking for signed-in buyers
- RFC-062 Recovering from zero-result searches
- RFC-063 Search in five more languages
- RFC-064 Sponsored listings in search results

specs/

- SPEC-059 Search query API
- SPEC-060 Product index mapping
- SPEC-061 Ranking features
- SPEC-062 Facet configuration
- SPEC-063 Synonym file format
- SPEC-064 Suggestion index
- SPEC-065 Search analytics events
- SPEC-066 Embedding pipeline
- SPEC-067 Relevance judgement guidelines
- SPEC-068 Sponsored listing slots

research/

- RN-051 Search relevance baseline
- RN-052 Typo tolerance and click-through
- RN-053 Learning to rank offline evaluation
- RN-054 Learning to rank online experiment
- RN-055 Zero-result searches by category
- RN-056 Suggestion latency by index size
- RN-057 Embedding models compared for similar products
- RN-058 Facet use on category pages
- RN-059 Search latency at peak traffic
- RN-060 Language coverage of the catalog

## product/mobile/

rfcs/

- RFC-065 Offline cart in the app
- RFC-066 Push notification preferences
- RFC-067 An app start time budget
- RFC-068 A server-driven home screen
- RFC-069 Biometric sign-in
- RFC-070 Progressive image formats in the app
- RFC-071 Deep links for every product and order
- RFC-072 Weekly app releases
- RFC-073 In-app review prompts

specs/

- SPEC-069 App navigation map
- SPEC-070 Push notification payloads
- SPEC-071 Deep link routes
- SPEC-072 Home screen layout schema
- SPEC-073 App analytics events
- SPEC-074 Offline storage
- SPEC-075 App release checklist
- SPEC-076 Minimum supported OS versions
- SPEC-077 Accessibility requirements for the app

research/

- RN-061 App start time by device class
- RN-062 Crash-free sessions by release
- RN-063 Push notification opt-in rates
- RN-064 Image formats and data usage
- RN-065 Server-driven home screen experiment
- RN-066 OS versions of app users
- RN-067 Biometric sign-in adoption
- RN-068 App size by release
- RN-069 Review prompt timing experiment

## product/sellers/

rfcs/

- RFC-074 A bulk listing editor in Seller Hub
- RFC-075 Inventory sync from seller systems
- RFC-076 A seller performance dashboard
- RFC-077 Faster seller payouts
- RFC-078 Shipping label printing
- RFC-079 Seller onboarding in one session
- RFC-080 Return requests handled by sellers
- RFC-081 A listing quality score

specs/

- SPEC-078 Seller account model
- SPEC-079 Listing fields and validation
- SPEC-080 Inventory sync protocol
- SPEC-081 Payout schedule
- SPEC-082 Seller performance metrics
- SPEC-083 Shipping label API
- SPEC-084 Return request flow
- SPEC-085 Listing quality score
- SPEC-086 Seller Hub roles and permissions

research/

- RN-070 Seller onboarding drop-off
- RN-071 Listing quality and conversion
- RN-072 Inventory sync errors by integration
- RN-073 Payout timing and seller satisfaction
- RN-074 Bulk editor use
- RN-075 Late shipments by carrier
- RN-076 Return reasons by category
- RN-077 Seller Hub page load times

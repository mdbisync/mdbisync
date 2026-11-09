| Owners | DemoAlice, DemoBob |
| -- | -- |
| Published | 2026-04-06 |
| Next edition | April 2027 |

The technology radar lists the languages, tools and platforms DemoCompany's engineers use or are looking at, in four rings. It is a guide for new work, not a rule for existing code; decisions that matter are ADRs.

| Ring | Meaning |
| -- | -- |
| Adopt | Use it by default for new work |
| Trial | Use it in production where it fits, and share what you learn |
| Assess | Worth a spike or a prototype; not yet in production |
| Hold | Do not start new work with it |

@@picture:eng-radar-2026@@

## Languages and frameworks

| Item | Ring | Why |
| -- | -- | -- |
| Go | Adopt | Default for backend services ([ADR-003](@ADR-003)) |
| TypeScript and Next.js | Adopt | The web shop ([ADR-023](@ADR-023)) |
| Kotlin with Jetpack Compose, Swift with SwiftUI | Adopt | The app ([ADR-024](@ADR-024)) |
| GraphQL for backends-for-frontends | Trial | Seller Hub ([ADR-043](@ADR-043)) |
| Kotlin Multiplatform for shared app logic | Assess | Only if shared logic grows |
| Node.js for backend services | Hold | Two services left; no new ones |

## Data

| Item | Ring | Why |
| -- | -- | -- |
| PostgreSQL 16 | Adopt | The transactional store ([ADR-004](@ADR-004)) |
| Kafka with Protobuf and a schema registry | Adopt | Domain events ([ADR-005](@ADR-005), [ADR-026](@ADR-026)) |
| ClickHouse | Adopt | Analytics ([ADR-011](@ADR-011)) |
| Debezium | Trial | Read models from change data capture ([ADR-036](@ADR-036)) |
| Vector search in OpenSearch | Trial | Similar products ([ADR-045](@ADR-045)) |
| MySQL, document databases | Hold | Retired ([ADR-004](@ADR-004)) |

## Platform

| Item | Ring | Why |
| -- | -- | -- |
| Managed Kubernetes, Argo CD, Terraform | Adopt | [ADR-002](@ADR-002), [ADR-008](@ADR-008), [ADR-009](@ADR-009) |
| OpenTelemetry | Adopt | [ADR-010](@ADR-010) |
| Temporal | Trial | Fulfilment ([ADR-040](@ADR-040)) |
| Service mesh for mutual TLS | Assess | [RFC-005](@RFC-005) and [RN-004](@RN-004) |
| Virtual machines for services | Hold | Everything runs on Kubernetes |

## Tools

| Item | Ring | Why |
| -- | -- | -- |
| k6 load tests in the pipeline | Adopt | [ADR-046](@ADR-046) |
| Ephemeral CI runners | Adopt | [ADR-031](@ADR-031) |
| Generated SDKs from OpenAPI | Trial | [RFC-035](@RFC-035) |
| Hand-written API clients | Hold | Replaced by generated clients |

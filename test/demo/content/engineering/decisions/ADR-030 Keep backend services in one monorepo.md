| Status | Accepted |
| -- | -- |
| Date | 2026-01-22 |
| Authors | DemoDave |
| Reviewers | DemoBob, DemoFrank |

## Context

Backend code lives in 19 repositories: twelve services, the Go kit, Protobuf contracts and five libraries. A change to a gRPC contract ([ADR-006](@ADR-006)) needs pull requests in three to six repositories, merged in the right order. The Go kit has six versions in use at once, and a security fix in December took nine days to reach every service.

## Decision

Backend services, contracts and shared libraries live in **one Git repository**, `backend`, with one Go module per service and a shared `go.work`.

* Layout: `services/<name>/`, `kit/`, `proto/`, `tools/`.
* Every service builds against the kit at the same commit; there are no kit versions.
* CI builds and tests only what a change affects, using the module graph; a full build runs nightly.
* Ownership per folder through a `CODEOWNERS` file; a service team reviews changes to its folder.
* The web shop, the apps and the infrastructure keep their own repositories.

```text
backend/
  go.work
  kit/
  proto/
    events/
    services/
  services/
    catalog-svc/
    orders-svc/
    ...
  tools/
```

## Options considered

| Option | Pull requests for a contract change | Time to roll a kit fix to all services | CI time per change (median) | Verdict |
| -- | -- | -- | -- | -- |
| **One monorepo, affected-only CI** | **1** | **1 day** | **7 min** | **Chosen** |
| Many repositories with automated update bots | 3 to 6 | 2 to 3 days | 6 min | Still out-of-order merges |
| Many repositories (today) | 3 to 6 | 9 days | 6 min | The problem we have |

## Consequences

* Atomic changes across services and contracts.
* CI must be smart about what it builds; without it, every change would take 40 minutes ([RN-003](@RN-003)).
* Repository permissions become coarser; `CODEOWNERS` and branch protection carry the rules.

## Follow-up

- [X] Move the Go kit and contracts
- [X] Move all Go services with history
- [ ] Move the two remaining Node.js services or retire them

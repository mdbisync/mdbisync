| Status | Draft |
| -- | -- |
| Created | 2026-09-29 |
| Authors | DemoErin |
| Reviewers | DemoFrank, DemoMike |
| Target | Q1 2027 |
| Builds on | [RFC-002 A shared service template for Go services](@RFC-002) |

## Summary

A single command takes a team from an empty idea to a service running in production: repository folder, CI, service manifest, database, Kafka topics, dashboards, alerts and an entry in the service catalogue. Every step has a default; teams leave the path only where they need to.

## Motivation

The service template ([RFC-002](@RFC-002)) solved the code. Everything around it is still manual. The last three new services needed a median of 9 working days and 14 pull requests across four repositories before their first production request. Most steps are the same every time.

## Proposal

@@picture:rfc-011-golden-path@@

### What the path creates

| Step | Created | Default |
| -- | -- | -- |
| Code | service from the template | Go, HTTP and gRPC |
| Manifest | [service manifest](@SPEC-001) | 2 to 10 pods, request-rate autoscaling ([RFC-003](@RFC-003)) |
| Database | PostgreSQL database and user ([ADR-015](@ADR-015)) | none unless asked |
| Events | topics by the [naming rules](@SPEC-021) | none unless asked |
| Delivery | pipeline with the standard stages ([SPEC-003](@SPEC-003)) | canary releases ([RFC-001](@RFC-001)) |
| Telemetry | dashboards and an availability objective ([SPEC-008](@SPEC-008)) | 99.9 % |
| Cost | labels ([SPEC-014](@SPEC-014)) | from the owning team |

```sh
demo-platform new service \
  --name returns-svc \
  --team sellers \
  --database postgres \
  --topics returns.events
```

The command opens one pull request in the monorepo and one in the environments repository ([ADR-008](@ADR-008)). Merging both is all it takes.

## Alternatives

| Option | Why not |
| -- | -- |
| A checklist page | Exists today; steps are still done by hand and skipped |
| A developer portal product | Large adoption effort for twelve to twenty services |
| **One command producing two pull requests** | Proposed |

## Rollout

- [ ] Prototype for code, manifest and pipeline
- [ ] Database and topics
- [ ] Dashboards and objectives
- [ ] First new service on the path; measure days to first production request

## Open questions

* Should the path also create an RFC stub? Most services start from an RFC already, so probably not.
* Who owns the path when a default changes: the platform team or the team that owns the default (for example the data team for topics)?

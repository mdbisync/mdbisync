| Status | In review |
| -- | -- |
| Created | 2026-08-18 |
| Authors | DemoMike |
| Reviewers | DemoErin, DemoHeidi, DemoKen |
| Target | Q4 2026 |
| Specification | [SPEC-013 Preview environment lifecycle](@SPEC-013) |

## Summary

Give every pull request that changes the web shop or a customer-facing service its own short-lived environment, with a URL posted on the pull request, so reviewers and designers can try the change before it is merged.

## Motivation

Today changes are tried in the one shared staging environment. In Q2 2026 staging was broken by an unmerged change on 19 of 64 working days, and the median wait for a slot to test a change by hand was 1.5 days. Designers review screenshots instead of the running page.

## Proposal

A preview environment is a namespace with the changed services built from the pull request and every other service pointing at shared staging dependencies.

@@picture:rfc-007-preview@@

### What a preview contains

| Part | In the preview | Shared with staging |
| -- | -- | -- |
| Changed services | built from the pull request | |
| Unchanged services | | yes, through routing headers |
| Databases | a schema copy for changed services only | the rest |
| Kafka | | yes, topics prefixed per preview |
| Seed data | 200 demo products, 3 demo sellers | |

Routing works with a header: requests to `pr-1234.preview.demomart.example.com` carry `x-preview: pr-1234`, and the gateway sends them to the preview's version of a service when one exists.

```yaml
preview:
  trigger: pull_request
  paths: ["web/**", "services/cart-svc/**", "services/checkout-svc/**"]
  ttl_hours: 72
  max_concurrent: 25
  seed: demo-small
```

The lifecycle (create, update on push, sleep, delete) is in [SPEC-013](@SPEC-013).

## Alternatives

| Option | Isolation | Cost per month | Why not |
| -- | -- | -- | -- |
| Shared staging (today) | none | included | The problem |
| A full copy of production per pull request | full | about 9,000 USD at 25 previews | Too expensive and slow, 40 min to start |
| **Changed services only, routed by header** | **per change** | **about 1,400 USD** | Proposed |
| Local development clusters | per developer | none | Designers and reviewers cannot open them |

## Rollout

- [ ] Routing by header in the gateway and in gRPC clients
- [ ] Preview controller, namespaces and time-to-live
- [ ] Pilot with the web shop team for four weeks
- [ ] Open to all customer-facing services

## Open questions

* Kafka consumers in a preview read shared topics; should they get their own consumer group per preview so they do not steal staging's messages? Proposed: yes, with a `pr-<number>` suffix.
* Previews of `demo-pay` are excluded until the payment provider's sandbox allows more than one callback URL.

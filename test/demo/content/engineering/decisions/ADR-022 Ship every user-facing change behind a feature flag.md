| Status | Accepted |
| -- | -- |
| Date | 2025-10-06 |
| Authors | DemoBob |
| Reviewers | DemoLaura, DemoNina |
| Specification | [SPEC-009 Feature flag evaluation API](@SPEC-009) |

## Context

Releasing and launching are the same step: a change is visible to every buyer the moment it deploys. Rolling back a bad change means a new deploy, which took 22 minutes on average in 2025, and the web shop and the app cannot launch a feature on the same day because the app ships through store review.

## Decision

Every change that buyers or sellers can see ships **behind a feature flag**, off by default.

* Flags are evaluated by `flags-svc` through the API in [SPEC-009](@SPEC-009); the web shop, the app and services use the same flags.
* A flag rolls out by percentage of users, by country or by seller segment; the default ramp is 1 %, 10 %, 50 %, 100 % over at least two days.
* Each flag has an owner and an expiry date. Flags older than 90 days at 100 % are removed from code; CI lists them weekly.
* Turning a flag off takes effect within 30 seconds.

```yaml
key: checkout.one-page
description: One-page checkout instead of three steps
owner: checkout
expires: 2026-01-31
rules:
  - countries: [DE, NL]
    rollout: 10
  - rollout: 0
```

## Options considered

| Option | Time to undo a bad launch | Launch web and app together | Cost | Verdict |
| -- | -- | -- | -- | -- |
| **Flags for every user-facing change** | **30 s** | **yes** | **flag clean-up work** | **Chosen** |
| Flags only for large features | 30 s or 22 min | sometimes | less clean-up | Small changes caused 60 % of 2025 rollbacks |
| Hosted flag service | 30 s | yes | about 1,400 USD a month | Our needs are simple; may revisit |
| No flags (today) | 22 min | no | none | The problem we have |

## Consequences

* Launches become a decision, separate from deploys; experiments like [RN-042](@RN-042) run on the same flags.
* Code carries both paths for a while; stale flags are technical debt we track.

## Follow-up

- [X] `flags-svc` and SDKs for Go, TypeScript, Kotlin and Swift
- [X] Weekly stale flag report
- [ ] Flag state shown in the deploy dashboard

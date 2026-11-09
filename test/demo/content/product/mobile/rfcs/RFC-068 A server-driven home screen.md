| Status | Implemented |
| -- | -- |
| Created | 2026-01-14 |
| Authors | DemoLaura |
| Reviewers | DemoNina, DemoOscar, DemoJudy |
| Target | App 5.5, Q1 2026 |
| Decision | [ADR-022 Ship every user-facing change behind a feature flag](@ADR-022) |

## Summary

Describe the app's home screen as a list of sections sent by a new `home-svc`, so the order and content of the home screen can change without an app release. The app renders only section types it knows and skips the rest.

## Motivation

* The home screen layout is compiled into the app. Moving the "recently viewed" row up took three weeks, because it waited for the next release and store review.
* About 30 % of app users run a release older than four weeks, so a change reaches most users only after two months.
* Campaigns need the home screen for a few days; today each one is a feature flag and a code path that stays in the app for good.

## Proposal

@@picture:rfc-068-home-screen@@

### The layout document

`GET /v2/home` returns an ordered list of sections ([SPEC-072](@SPEC-072)):

```json
{
  "layout_id": "home-2026-03-02-b",
  "ttl_seconds": 900,
  "sections": [
    { "type": "search_bar" },
    { "type": "banner", "image": "https://img.example.com/c/spring.avif", "target": "demomart://campaign/spring" },
    { "type": "product_row", "title": "Picked for you", "source": "reco:personal", "limit": 12 },
    { "type": "category_grid", "categories": ["home", "garden", "kitchen", "toys"] },
    { "type": "product_row", "title": "Recently viewed", "source": "history", "limit": 10 }
  ]
}
```

### What the app does

* Renders the sections in order; an unknown `type` is skipped, so new section types can ship to new releases first.
* Caches the last layout for 24 hours and shows it on start, then refreshes behind it ([RFC-067](@RFC-067)).
* Falls back to a built-in layout when there is no cache and no network.

### What home-svc does

It builds the layout from feature flags (targeting by country, app version and segment), personal rows from `reco-svc`, and campaigns with start and end dates. Layout decisions are logged as analytics events so experiments can compare layouts ([SPEC-073](@SPEC-073)).

## Alternatives

| Option | Change without release | Native look | Why not |
| -- | -- | -- | -- |
| Web view for the home screen | yes | no | Slow first draw, feels foreign |
| Remote config values for each row | partly | yes | Every new layout still needs code |
| **Sections from home-svc** | **yes** | **yes** | Chosen |

## Rollout

- [X] `home-svc` with the five section types above
- [X] App renders sections behind the `server_home` flag
- [X] Experiment against the fixed layout ([RN-065](@RN-065))
- [X] All users on the server-driven home screen
- [ ] Section types for seller stores, after [RFC-076](@RFC-076)

## Open questions

* Who may change the production layout? For now only through a reviewed configuration change, like any flag.

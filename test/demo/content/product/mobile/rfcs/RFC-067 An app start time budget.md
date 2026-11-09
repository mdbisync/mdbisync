| Status | Accepted |
| -- | -- |
| Created | 2025-12-02 |
| Authors | DemoOscar |
| Reviewers | DemoNina, DemoKen |
| Target | App 5.8, Q2 2026 |
| Evidence | [RN-061 App start time by device class](@RN-061) |

## Summary

Set a budget for cold start: 2,000 ms on low-end Android and 1,000 ms on a recent iPhone, from tapping the icon to the first product image on the home screen. Split the budget by phase, measure it on every build, and block a release that exceeds it by more than 10 %.

## Motivation

[RN-061](@RN-061) measured a median cold start of 3,420 ms on low-end Android and 890 ms on a recent iPhone. Sessions that took more than 3 seconds to start ended without a product view 1.6 times as often. Low-end Android devices are 22 % of our Android users.

Start time has grown with every release because nobody owns it: each feature adds a little work at start, and no single change looks expensive.

## Proposal

### The budget

@@picture:rfc-067-start-budget@@

| Phase | Low-end Android today | Budget | Main change |
| -- | -- | -- | -- |
| Process start and runtime | 610 ms | 500 ms | Baseline profiles, fewer content providers |
| Dependency injection graph | 940 ms | 300 ms | Create objects lazily, on first use |
| Home screen request | 1,050 ms | 400 ms | Show the cached layout, refresh behind it |
| First image decode | 520 ms | 400 ms | Smaller first images ([RFC-070](@RFC-070)) |
| Layout and first draw | 300 ms | 400 ms | No change needed |
| **Total** | **3,420 ms** | **2,000 ms** | |

### Lazy dependencies

Most of the graph is created at start although the home screen needs a fifth of it.

```kotlin
@Module
object CheckoutModule {
    @Provides
    fun paymentClient(http: Lazy<HttpClient>): PaymentClient =
        PaymentClient { http.get() } // created on the first checkout, not at start
}
```

### Measuring

Every merge to the main branch runs a start benchmark on two reference devices per platform, 30 cold starts each. The median goes to the release dashboard; a regression over 10 % fails the release checklist ([SPEC-075](@SPEC-075)).

```swift
func testColdStart() {
    measure(metrics: [XCTApplicationLaunchMetric(waitUntilResponsive: true)]) {
        XCUIApplication().launch()
    }
}
```

## Alternatives

| Option | Effect | Why not |
| -- | -- | -- |
| A splash screen with an animation | Feels faster, is not | Hides the problem |
| Rewrite the home screen in a cross-platform toolkit | Unknown | Against [ADR-024](@ADR-024), large cost |
| **A budget per phase with a release gate** | **Measured, owned** | Chosen |

## Rollout

- [X] Start benchmark on reference devices in the pipeline
- [X] Lazy dependency graph on Android
- [X] Cached home layout on start ([RFC-068](@RFC-068))
- [ ] Release gate on in the checklist
- [ ] Re-measure in the field after app 5.8

## Open questions

* Should warm start get its own budget? Warm starts are already under 1,310 ms everywhere; revisit after the cold start work.

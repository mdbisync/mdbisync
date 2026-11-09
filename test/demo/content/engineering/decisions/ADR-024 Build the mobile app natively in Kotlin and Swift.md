| Status | Accepted |
| -- | -- |
| Date | 2025-11-02 |
| Authors | DemoNina |
| Reviewers | DemoLaura, DemoPeggy |

## Context

The DemoMart app is a web view wrapping the mobile web shop. Its store rating is 3.1, reviews mention slowness and lost carts, and it cannot use biometric sign-in, rich push notifications or offline storage well. App buyers order 1.8 times as often as web buyers, so the app matters more each quarter.

## Decision

The app is rebuilt **natively: Kotlin with Jetpack Compose on Android, Swift with SwiftUI on iOS.**

* Two platform teams share designs, design tokens ([ADR-025](@ADR-025)), API contracts and the release train ([RFC-072](@RFC-072)).
* The home screen is server-driven ([RFC-068](@RFC-068)) so merchandising does not need app releases.
* Minimum versions per [SPEC-076](@SPEC-076); accessibility per [SPEC-077](@SPEC-077).
* Business rules stay on the server; the apps do not duplicate pricing, tax or eligibility logic.

## Options considered

| Option | Start time on a mid-range phone (prototype) | Platform features | Engineers needed | Verdict |
| -- | -- | -- | -- | -- |
| **Native Kotlin and Swift** | **0.9 s** | **all** | **4 + 4** | **Chosen** |
| Kotlin Multiplatform with native UI | 1.0 s | all | 7 | Shared logic is small since rules live on the server |
| Cross-platform UI framework | 1.4 s | most, through plugins | 5 | Plugins for payments and biometrics lag behind |
| Web view (today) | 3.2 s | few | 2 | The problem we have |

Start times are measured as in [RN-061](@RN-061).

## Consequences

* Two codebases; features ship on both platforms in the same release train.
* Hiring for two platform teams.
* The web view app stays in the stores until the native app reaches parity, planned for six months.

## Follow-up

- [X] Native browse, search and product pages
- [X] Native cart and checkout
- [ ] Native account and order history
- [ ] Remove the web view app

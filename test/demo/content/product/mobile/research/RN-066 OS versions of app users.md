| Status | Complete |
| -- | -- |
| Date | 2026-10-05 |
| Authors | DemoNina |
| Led to | [SPEC-076 Minimum supported OS versions](@SPEC-076) |

## Question

Which operating system versions do DemoMart app users run, and how many buyers would we lose if the next minimum supported version moved up by one on each platform?

## Method

* Monthly active users of the app in September 2026, counted once per buyer on the device they used most.
* Orders per user from the same month, to weigh how much each group buys, not only how many there are.
* Shares are of all app users across both platforms, so the iOS and Android rows add up to 100 % together (iOS 42.7 %, Android 57.3 %).

## Results

@@picture:rn-066-os-versions@@

@@table:rn-066-os-versions@@

@@csv:rn-066-os-versions@@

| Group | Share of users | Share of app orders |
| -- | -- | -- |
| iOS 16 and older | 2.1 % | 1.4 % |
| Android 11 and older | 2.8 % | 1.9 % |
| Android 12 | 5.4 % | 4.8 % |

## Findings

* Two versions per platform cover most users: iOS 18 and 17 together 40.6 %, Android 15 and 14 together 39.0 %.
* The oldest groups are small and buy less than average: iOS 16 and older are 2.1 % of users and 1.4 % of app orders; Android 11 and older 2.8 % and 1.9 %.
* Android 12 is still 5.4 % of users and buys almost as much as average; raising the Android minimum past it would cost too much this year.
* Supporting iOS 16 keeps a separate code path for the photo picker and for live activities, about 1,900 lines with their own tests.

## Recommendation

From app 5.25 (Q1 2027), require iOS 17 and Android 12. Buyers on older versions keep the web shop, which supports older browsers, and see a notice in the app for two releases before. Recorded in [SPEC-076](@SPEC-076).

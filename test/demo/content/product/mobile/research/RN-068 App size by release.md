| Status | Complete |
| -- | -- |
| Date | 2026-07-15 |
| Authors | DemoOscar |
| Led to | [SPEC-075 App release checklist](@SPEC-075) |

## Question

How has the app's download size changed over the releases of 2026, what made it grow, and what did the clean-up in release 5.7 achieve?

## Method

* Download size from each store's size report for a typical device: a recent iPhone and a mid-range Android phone with an app bundle split by screen density and CPU architecture.
* Size by component from the build's size analysis: code, resources, images and fonts, and native libraries.
* Releases 5.1 to 5.12, January to June 2026.

## Results

@@picture:rn-068-app-size@@

@@table:rn-068-app-size@@

@@csv:rn-068-app-size@@

| Change in 5.7 | iOS | Android |
| -- | -- | -- |
| Unused onboarding videos removed | −3.9 MB | −3.9 MB |
| Icon font replaced by vector icons | −1.4 MB | −1.4 MB |
| Second analytics library removed | −1.2 MB | −2.8 MB |
| Images moved to on-demand download | −0.4 MB | −0.5 MB |

## Findings

* Before 5.7 the app grew by about 0.8 MB per release on both platforms. Half of that growth was images for campaigns and onboarding that most buyers never see.
* Release 5.7 cut 6.9 MB on iOS (65.3 to 58.4 MB) and 8.6 MB on Android (42.1 to 33.5 MB).
* After 5.7 growth slowed to about 0.5 MB per release, mostly code.
* Store data shows install conversion falls for downloads over 100 MB on mobile networks; we are far below that, but the trend matters more than the size.

## Recommendation

Add a size check to the release checklist: a release that grows the download by more than 1.5 MB needs a note explaining why ([SPEC-075](@SPEC-075)). Serve campaign images from the server-driven home screen ([RFC-068](@RFC-068)), never from the app bundle.

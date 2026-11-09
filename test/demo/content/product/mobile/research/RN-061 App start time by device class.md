| Status | Complete |
| -- | -- |
| Date | 2025-11-26 |
| Authors | DemoOscar, DemoKen |
| Led to | [RFC-067 An app start time budget](@RFC-067) |

## Question

How long does the DemoMart app take from a tap on its icon to the first product image on the home screen, on the devices our buyers actually use, and which phase of the start takes the time?

## Method

* Field data from app 4.22 over 14 days: 2.1 million cold starts and 6.4 million warm starts, recorded with the start trace described in [SPEC-073](@SPEC-073).
* Devices grouped into five classes by memory and CPU benchmark score, as in [SPEC-076](@SPEC-076).
* The end point is the first product image drawn, not the first frame: a blank home screen does not count as started.
* For the phase split, 30 traced cold starts on one low-end Android reference device in the lab.

## Results

@@picture:rn-061-start-time@@

@@table:rn-061-start-time@@

@@csv:rn-061-start-time@@

@@picture:rn-061-phases@@

@@table:rn-061-phases@@

## Findings

* Low-end Android needs 3,420 ms for a cold start, almost four times a recent iPhone (890 ms). Low-end Android devices are 22 % of our Android users.
* Warm starts are fine everywhere: at most 1,310 ms.
* On low-end Android, two phases take 58 % of the cold start: the home screen request (1,050 ms) and building the dependency injection graph (940 ms). Neither depends on the device being slow alone; both do work the first screen does not need.
* Sessions whose cold start took longer than 3 seconds ended without a product view 1.6 times as often as faster ones.

> [!IMPORTANT]
> A start time budget only holds if it is measured on every build. Field data arrives a week after a release, too late to stop it.

## Recommendation

Set a cold start budget of 2,000 ms on low-end Android and 1,000 ms on a recent iPhone, split by phase; build the dependency graph lazily and show a cached home layout on start. Proposed in [RFC-067](@RFC-067); the cached layout comes with [RFC-068](@RFC-068).

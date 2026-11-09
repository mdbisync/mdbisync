| Status | Complete |
| -- | -- |
| Date | 2025-10-07 |
| Authors | DemoMike |
| Led to | [RFC-013 Smaller container images](@RFC-013) |

## Question

How large are our service images, how much of that is needed at runtime, and how does size affect the time a new pod needs on a fresh node?

## Method

* All twelve service images in the registry on 1 October 2025, compressed size.
* Contents listed layer by layer; known vulnerabilities from the registry scanner.
* Pull time on a freshly started node, median of 20 pulls per size.
* Updated on 9 December 2025 with sizes after [RFC-013](@RFC-013).

## Results

@@picture:rn-006-sizes@@

@@table:rn-006-sizes@@

@@picture:rn-006-pull@@

@@csv:rn-006-sizes@@

## Findings

* The median image across twelve services was 412 MB. A Go service binary is 15 to 20 MB; the rest was the operating system, compilers left from the build and package caches.
* Images carried 140 known vulnerabilities on average, 96 % in packages the service never loads.
* Pulling a 910 MB image took 38 seconds, most of a new pod's start time during scale-out.
* After the move, Go images are 21 to 31 MB. `reco-svc` is the exception at 420 MB: it is written in Python and ships a numerical library.

## Recommendation

Use two-stage builds and distroless bases for every service, fail CI on image growth above 20 %, and look at moving the model serving part of `reco-svc` into its own image.

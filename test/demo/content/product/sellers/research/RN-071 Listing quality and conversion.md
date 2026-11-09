| Status | Complete |
| -- | -- |
| Date | 2026-04-22 |
| Authors | DemoOscar, DemoNina |
| Led to | [RFC-081 A listing quality score](@RFC-081) |

## Question

Which properties of a listing predict whether a view turns into an order, and is the effect large enough to show sellers a score for it?

## Method

* 1.8 million active listings with at least 50 views between 2025-10-01 and 2026-03-31; 214 million listing views and 4.1 million orders.
* Conversion: orders divided by listing views, per listing.
* Candidate properties: photo count and size, filled attributes, title and description length, price against the category median, delivery estimate and tracking.
* A logistic regression on conversion fitted the component weights; we then rounded them to whole points out of 100 so sellers can follow the arithmetic. The rounded score keeps 94 % of the model's ranking quality (AUC 0.71 against 0.72).
* Category effects were removed by comparing listings within the same leaf category.

## Results

@@picture:rn-071-score-bands@@

@@table:rn-071-score-bands@@

@@csv:rn-071-score-bands@@

@@picture:rn-071-photos@@

@@table:rn-071-photos@@

## Findings

* Conversion rises steadily with the score: 0.6 % for listings scoring 20 or less, 3.6 % above 80. The relation holds in each of the ten largest categories.
* Photos carry the largest effect. Going from one photo to five raises conversion from 1.2 % to 3.1 %; beyond five there is no further gain.
* 38 % of active listings have one photo, and 27 % have none of the attributes buyers filter on. Both are cheap for a seller to fix.
* Price matters, but less than expected once photos and attributes are in the model: listings within 10 % of the category median convert 1.4 times as well as those 25 % above.
* Listings scoring 81 or more are only 9 % of listings but take 31 % of orders.

## Recommendation

Introduce a rule-based score with the fitted weights (photos 30, attributes 25, text 20, price 15, shipping 10), show it to sellers with the single most valuable fix, and offer it to search as a ranking feature. Proposed in [RFC-081](@RFC-081), specified in [SPEC-085](@SPEC-085).

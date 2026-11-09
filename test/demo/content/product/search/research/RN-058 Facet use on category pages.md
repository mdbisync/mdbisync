| Status | Complete |
| -- | -- |
| Date | 2025-12-05 |
| Authors | DemoJudy |
| Led to | [SPEC-062 Facet configuration](@SPEC-062), version 2.0 |

## Question

Six weeks after facets launched on category pages ([RFC-056](@RFC-056)), which facets do buyers use, and do facet users buy more?

## Method

* All category-page sessions from 2025-10-20 to 2025-11-30 on web and app: 7.8 million sessions.
* A session "uses" a facet if it applies at least one value of it. Conversion is an order within the session.
* Facet position was fixed during the period, so the order of the list below is not caused by position alone; we checked it against a one-week shuffle on 5 % of traffic, which gave the same top four.

## Results

@@picture:rn-058-use@@

@@table:rn-058-use@@

@@csv:rn-058-use@@

| Sessions | Share | Conversion |
| -- | -- | -- |
| No facet applied | 71 % | 2.3 % |
| One or more facets applied | 29 % | 4.6 % |

## Findings

* Price and size lead by far; brand is third. Colour is used mostly in fashion and furniture.
* "Seller location" is applied in 0.6 % of sessions. "Delivery by date" is used in 6.8 %, more than the material and style facets together, although it sits in sixth place, below rating. The chart lists facets in their order on the page.
* Facet users convert twice as often. Part of that is intent (people who filter are closer to buying), so we do not count it as a gain caused by facets.
* On the app, 38 % of facet panels are opened and closed without applying a value, against 21 % on the web. The app shows only the first four values per facet.

## Recommendation

* Move "Delivery by date" up to fourth place in every category; drop "Seller location" from the default set ([SPEC-062](@SPEC-062)).
* Show counts next to values and allow "show all" on the app ([SPEC-069](@SPEC-069)).

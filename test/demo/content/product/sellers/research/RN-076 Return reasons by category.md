| Status | Complete |
| -- | -- |
| Date | 2026-06-23 |
| Authors | DemoErin, DemoJudy |
| Led to | [RFC-080 Return requests handled by sellers](@RFC-080) |

## Question

Why do buyers return items, how does it differ by category, and which returns could a seller decide on without DemoMart support?

## Method

* All 412,000 return requests opened between 2025-12-01 and 2026-05-31, with the reason the buyer chose and the outcome support recorded.
* Return rate: return requests divided by delivered order lines, per category.
* Five categories with the most orders; together 78 % of order lines.
* Support's outcome per request: approved unchanged, approved with changes (partial refund or a different label), or refused.

## Results

@@picture:rn-076-rate@@

@@table:rn-076-rate@@

@@picture:rn-076-reasons@@

@@table:rn-076-reasons@@

@@csv:rn-076-reasons@@

## Findings

* Fashion stands out with a return rate of 18.4 %, three times that of home goods (6.2 %). Beauty is lowest at 3.1 %.
* In fashion, 54 % of returns are for the wrong size or fit. Sellers can do something about that (size charts, exchanges), and they ask to handle these returns themselves.
* "Not as described" and "damaged" together are 31 % of electronics returns and 33 % of home returns. These are the returns where a buyer and a seller are most likely to disagree.
* Support approved 93 % of all requests unchanged, 5 % with changes and refused 2 %. A median request took 9.4 days from opening to refund, of which 3.1 days were waiting for support's first look.
* Refusals were almost all "changed mind" requests after the 30-day window.

## Recommendation

Let sellers decide on return requests, with automatic approval when they do not answer, and keep support for disputes. Do not let sellers refuse "damaged" or "not as described" returns with photos. Count only those two reasons in the seller's return rate ([SPEC-082](@SPEC-082)). Proposed in [RFC-080](@RFC-080); flow in [SPEC-084](@SPEC-084).

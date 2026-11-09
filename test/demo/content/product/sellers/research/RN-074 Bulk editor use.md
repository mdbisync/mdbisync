| Status | Complete |
| -- | -- |
| Date | 2026-09-14 |
| Authors | DemoNina, DemoJudy |
| Led to | Follow-up items in [RFC-074 A bulk listing editor in Seller Hub](@RFC-074) |

## Question

Did the bulk editor, open to all sellers since 2026-07-21, take over listing edits from page-by-page editing and CSV uploads, and did it make large edits faster?

## Method

* Listing edits by source from 2026-06-22 to 2026-09-13: single edits in Seller Hub, the bulk editor, CSV upload and the API. One changed field on one listing counts as one edit.
* Time for a "category price change": from opening the listings page to the last saved change, for sessions that changed the price of 50 or more listings in one category. Compared four weeks before launch with weeks 5 to 8 after it.
* Rejected rows per job from the bulk import pipeline ([SPEC-041](@SPEC-041)).

## Results

@@picture:rn-074-weekly-edits@@

@@table:rn-074-weekly-edits@@

@@csv:rn-074-weekly-edits@@

@@picture:rn-074-task-time@@

@@table:rn-074-task-time@@

## Findings

* Bulk edits grew from 18,000 a week in the beta to 96,000 by week 12, while single edits fell from 140,000 to 101,000 and CSV uploads from 52,000 to 21,000.
* A category price change now takes a median of 6 minutes instead of 47. The 90th percentile fell from 2 hours 10 minutes to 19 minutes.
* 2.4 % of bulk rows are rejected, against 4.2 % of CSV rows; the grid catches most errors as the seller types ([SPEC-079](@SPEC-079)).
* 71 % of bulk jobs change prices; 18 % change stock; 11 % change status. Title changes in bulk are rare.
* Sellers with fewer than 100 listings rarely use the grid; for them, single edits remain the norm.

## Recommendation

Keep the bulk editor as the default for sellers with more than 100 listings and link to it from the listings page. Add undo for a whole job, which beta sellers asked for most. Retire the advanced CSV help pages once CSV uploads drop below 5 % of edits, as planned in [RFC-074](@RFC-074).

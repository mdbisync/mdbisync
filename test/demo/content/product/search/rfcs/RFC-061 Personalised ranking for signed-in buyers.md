| Status | Rejected |
| -- | -- |
| Created | 2026-02-23 |
| Authors | DemoHeidi |
| Reviewers | DemoNina, DemoGrace, DemoPeggy |
| Target | Q2 2026 |
| Decision | Rejected on 2026-04-17; see "Decision" below |

## Summary

Add per-buyer features to the learning-to-rank model of [RFC-057](@RFC-057): affinity to categories, brands and price ranges from the buyer's last 180 days of views and orders, so that two buyers searching "running shoes" see different orders.

## Motivation

Ranking today is the same for everyone. Offline, adding six personal features to the 48 core features of [SPEC-061](@SPEC-061) raised NDCG@10 on click-labelled sessions of signed-in buyers from 0.69 to 0.73. Competitors' search is widely assumed to be personalised, and the product team asked whether DemoMart should follow.

## Proposal

@@picture:rfc-061-features@@

* A nightly job computes a profile per signed-in buyer: top 20 categories, top 20 brands, and median price paid per top-level category, with exponential decay (half-life 45 days).
* Profiles are stored in Redis, keyed by an opaque buyer key, 1.1 KB each, about 2.4 GB for all active buyers.
* `search-svc` fetches the profile with the query (budget 3 ms) and passes six features to the model: category affinity, brand affinity, price distance, and three interaction features.
* Buyers can switch personalisation off in their privacy settings; signed-out buyers are unaffected.

## Online test

An A/B test ran for 21 days from 2026-03-16 on signed-in sessions only (4.1 million searches).

| Measure | Control | Personalised | Change |
| -- | -- | -- | -- |
| Purchases per 1,000 searches | 36.2 | 36.9 | +1.9 %, not significant (95 % interval −0.8 % to +4.6 %) |
| Searches followed by a click | 52.1 % | 53.0 % | +0.9 points |
| Distinct sellers in the top 10 | 7.8 | 6.1 | −22 % |
| p99 latency | 171 ms | 183 ms | +12 ms |

## Decision

Rejected. The offline gain did not turn into a significant purchase lift, while results became visibly narrower: fewer sellers reached the top 10, and smaller sellers lost 14 % of their search impressions in the test. The profile store adds personal data to search ([ADR-028](@ADR-028) would require field encryption for it) and a new dependency on the hot path, for no measurable benefit.

## Alternatives considered instead

| Option | Personal data | Status |
| -- | -- | -- |
| Session-only context (categories viewed in this session) | none stored | Worth testing; no profile, no store |
| "Recently viewed" row next to results | already stored for the app | Shipped separately in the app |
| **No personalisation of ranking** | none | Current state |

## Follow-up

- [X] Remove the profile job and the Redis keys created for the test
- [X] Record the result in the search team's experiment log
- [ ] Draft a session-context experiment with no stored profile

## Open questions

* Would a longer test show a lift for frequent buyers only? The test had too few of them (6 % of sessions) to tell.

| Status | Rejected |
| -- | -- |
| Created | 2026-08-19 |
| Authors | DemoMike |
| Reviewers | DemoNina, DemoOscar, DemoPeggy, DemoKen |
| Target | Q4 2026 |
| Decision | Keep the two-week release train; see Outcome |

## Summary

Release the DemoMart app every week instead of every two weeks, with a release branch cut every Monday and a staged rollout of 1, 10, 50 and 100 %.

## Outcome

Rejected on 2026-09-09. The review found that the two-week train is not what limits delivery speed: fixes already ship as hotfixes, and features ship behind flags ([ADR-022](@ADR-022)). Crash rates were highest in releases whose testing time had been cut short ([RN-062](@RN-062)), and a weekly train would cut it every time. Instead, the team shortens the checklist ([SPEC-075](@SPEC-075)) and keeps two weeks.

## Motivation

* Changes wait a median of 9 days between merge and the store.
* Hotfixes happen in about one release out of four and disrupt the next release's testing.
* Some teams would like to see experiment results sooner.

## Proposal

@@picture:rfc-072-release-train@@

### Schedule

| Day | Step |
| -- | -- |
| Monday, week 1 | Branch cut at 10:00; only fixes after that |
| Monday to Wednesday | Internal testing with the release checklist |
| Thursday | Submit to both stores |
| Monday, week 2 | Rollout to 1 % |
| Tuesday to Wednesday | 10 %, then 50 %, if crash-free sessions stay above 99.7 % |
| Friday | 100 % |

Two releases are always in flight: one in testing, one rolling out.

### Automation

```yaml
release_train:
  cadence: weekly
  branch_cut: "MON 10:00 Europe/Berlin"
  rollout_steps: [1, 10, 50, 100]
  halt_if:
    crash_free_sessions_below: 99.7
    new_crash_cluster_users_above: 200
```

## Alternatives

| Option | Time from merge to store | Testing time | Verdict |
| -- | -- | -- | -- |
| **Two-week train (today)** | **9 days median** | **5 days** | **Kept** |
| Weekly train | 5 days median | 3 days | Rejected |
| Continuous releases on merge | 2 days | none dedicated | Not with store review |

## What we do instead

- [X] Shorten the release checklist from 41 to 26 items
- [X] Automate screenshot checks for the 12 most-used screens
- [ ] Halt rules for staged rollout, taken from this proposal
- [ ] Review again when crash-free sessions stay above 99.85 % on Android for six releases

## Open questions

* None left open; reopen with a new RFC if the conditions above are met.

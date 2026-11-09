| Status | Complete |
| -- | -- |
| Date | 2026-03-24 |
| Authors | DemoMike |
| Follows | [ADR-031 Replace self-hosted CI runners with ephemeral runners](@ADR-031) |

## Question

Did moving CI to ephemeral runners ([RFC-004](@RFC-004)) make pipelines faster and more reliable, and what does it cost?

## Method

* Four weeks before the move (12 January to 6 February 2026) and four weeks after (2 to 27 March 2026), working days only.
* 18,400 jobs before, 19,100 after, from all repositories in the monorepo.
* Duration: from job start to end, median per job type. Waiting: from queued to started.
* A failure counts as an "environment failure" if a retry on a clean runner passed without code changes.

## Results

@@picture:rn-003-duration@@

@@table:rn-003-duration@@

@@picture:rn-003-queue@@

@@csv:rn-003-queue@@

| Measure | Before | After |
| -- | -- | -- |
| Environment failures, share of failed jobs | 9 % | 0.3 % |
| Jobs restarted after a spot interruption | | 0.6 % |
| Runner cost per month | 3,100 USD | 1,650 USD |

## Findings

* Jobs got 28 to 33 % faster, mostly from caches in the bucket being warmer than the old machines' disks, and from never sharing a CPU with another job.
* Waiting at the 11:00 peak fell from 6.4 minutes to 0.5 minutes.
* Environment failures almost disappeared. The remaining 0.3 % are caused by the cache bucket's rate limits.
* Spot interruptions restarted 0.6 % of jobs, adding a median of 3 minutes to those jobs ([RN-007](@RN-007)).

## Recommendation

Keep the setup. Shard the cache bucket by repository path to remove the rate limit failures.

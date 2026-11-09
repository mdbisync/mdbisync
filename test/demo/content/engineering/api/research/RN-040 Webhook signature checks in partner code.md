| Status | Complete |
| -- | -- |
| Date | 2025-06-12 |
| Authors | DemoHeidi, DemoJudy |
| Led to | [RFC-039 Problem details for API errors](@RFC-039), [RFC-035 Generated SDKs for TypeScript, Python and Go](@RFC-035) |

## Question

How do partners handle the parts of an integration that are easy to get wrong: checking webhook signatures, retrying calls and reading errors? The answer decides what v2 and its tooling should do for them.

## Method

* 30 integrations that partners shared with us for review, in TypeScript, Python, PHP, Java and Go, covering about 40 % of v1 traffic.
* Each integration checked against a list of 12 practices, among them: constant-time signature comparison, timestamp checks, retries with backoff, safe retries of writes, and error handling that does not depend on message text.
* Time from first API key to first order taken from partner account records.

## Results

@@picture:rn-040-issues@@

@@table:rn-040-issues@@

@@picture:rn-040-days@@

@@table:rn-040-days@@

@@csv:rn-040-issues@@

A typical signature check found in the review, and what it should be:

```python
# Found: string comparison leaks timing, no timestamp check
if request.headers["X-Signature"] == expected:
    handle(request.json)

# Should be: constant time, timestamp within 5 minutes, raw body
if abs(time.time() - int(timestamp)) <= 300 and hmac.compare_digest(received, expected):
    handle(raw_body)
```

## Findings

* **Signature checks are weak or missing.** 11 integrations compared signatures as plain strings, which leaks timing; 6 did not check signatures at all. Only order webhooks were signed in v1, so most partners never wrote the check for other events.
* **Retries are naive.** 19 retried immediately or on a fixed short interval, and 7 retried writes without any way to avoid duplicates, the cause behind double refunds ([RN-037](@RN-037)).
* **Error handling depends on message text** in 14 integrations, because v1 had 9 error formats and no stable error codes.
* **Libraries help.** The 3 integrations that used a community library reached their first order in a median of 4 days, against 11 for those with their own HTTP code.

## Recommendation

* Use one error format with stable types in v2 ([RFC-039](@RFC-039)).
* Sign every webhook with a timestamp and document the check ([RFC-031](@RFC-031)).
* Provide official SDKs that do signatures, retries and idempotency correctly by default ([RFC-035](@RFC-035)).

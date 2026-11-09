| Status | Implemented |
| -- | -- |
| Date | 2026-07-31 |
| Authors | DemoHeidi |
| Reviewers | DemoJudy, DemoAlice |
| Policy | [RFC-037 Deprecation policy for API versions](@RFC-037) |
| Evidence | [RN-038 Migration from v1 to v2](@RN-038) |

## Context

API v2 was released in July 2025 ([ADR-016](@ADR-016)) and v1 was announced as deprecated with a sunset date of 30 June 2026, following [RFC-037](@RFC-037). By June, v1 still had 4 % of partner traffic, from 23 partners. Keeping v1 means keeping static API keys ([ADR-017](@ADR-017)), floating-point money and the fixed-window rate limiter alive. This record documents how the retirement was carried out and what stays.

## Decision

**API v1 stopped serving on 30 June 2026**, as announced, with a two-week grace period for the remaining partners that had a migration date agreed.

* From 1 June, v1 responses carried `Sunset: Tue, 30 Jun 2026 00:00:00 GMT`; from 15 June, v1 returned `410 Gone` for one minute every hour ("brownouts").
* On 30 June v1 started returning `410 Gone` with a problem details body pointing to the migration guide; the 6 partners with agreed dates kept access until 14 July through an allow-list.
* Static API keys were revoked on 14 July.

```json
{
  "type": "https://api.example.com/problems/version-retired",
  "title": "API v1 has been retired",
  "status": 410,
  "detail": "Use /v2. See the migration guide.",
  "instance": "/v1/orders"
}
```

## Options considered

| Option | Partners affected on the day | Systems kept alive | Verdict |
| -- | -- | -- | -- |
| **Retire on the announced date, short grace by agreement** | **0 unplanned (6 on an allow-list)** | **none after 14 July** | **Chosen** |
| Extend v1 by six months | 0 | static keys, old limiter, float money | Rewards waiting; announced dates lose meaning |
| Hard cut without brownouts | up to 23 | none | Partners would learn about it from outages |

## Consequences

* The old authentication, rate limiting and money code paths were deleted: about 14,000 lines.
* Brownouts surfaced 9 partners who had missed every email; all migrated before the date.
* The next retirement follows the same playbook.

## Follow-up

- [X] Sunset headers and brownouts
- [X] `410 Gone` on 30 June
- [X] Revoke static keys on 14 July
- [X] Delete v1 code

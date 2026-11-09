| Status | Accepted |
| -- | -- |
| Date | 2025-07-17 |
| Authors | DemoHeidi |
| Reviewers | DemoJudy, DemoDave |
| Plan | [RFC-030 Public API v2](@RFC-030) |

## Context

The public API has no version. Every change must stay compatible forever, and in 2025 we need breaking changes: money as integer minor units ([ADR-020](@ADR-020)), cursor pagination ([RFC-032](@RFC-032)) and one error format ([RFC-039](@RFC-039)). Partners need to move at their own pace, and support must see at a glance which version a partner calls.

## Decision

The major version is the **first path segment**: `https://api.example.com/v2/products`.

* Only breaking changes raise the major version. Additive changes (new fields, new endpoints, new enum values announced in advance) ship within a version.
* At most two major versions run at the same time. The older one gets a deprecation date at least 12 months after the newer one is released ([RFC-037](@RFC-037)).
* Responses of a deprecated version carry `Deprecation` and `Sunset` headers ([SPEC-042](@SPEC-042)).
* The current unversioned API is served as `/v1` and at the old paths until it is retired ([ADR-044](@ADR-044)).

```http
GET /v2/orders?limit=50 HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJhbGciOi...

HTTP/1.1 200 OK
Content-Type: application/json
```

## Options considered

| Option | Visible in logs and support tickets | Cacheable | Partner effort to switch | Verdict |
| -- | -- | -- | -- | -- |
| **Version in the path** | **yes** | **yes** | **change the base URL** | **Chosen** |
| Version in an `Accept` header | only with header logging | needs `Vary` | change every request | Hard to see and debug |
| Date-based versions per partner | yes, in account settings | yes | none at first | Many versions to keep alive |
| No versions (today) | no | yes | none | Blocks needed changes |

## Consequences

* Two versions run side by side for at least 12 months; `api-gateway` routes by prefix.
* SDKs ([RFC-035](@RFC-035)) are published per major version.
* Migration progress is tracked in [RN-038](@RN-038).

## Follow-up

- [X] Serve the old API under `/v1` as well
- [X] Release `/v2`
- [ ] Retire `/v1` ([ADR-044](@ADR-044))

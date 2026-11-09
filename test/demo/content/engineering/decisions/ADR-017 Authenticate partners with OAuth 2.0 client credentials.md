| Status | Implemented |
| -- | -- |
| Date | 2025-07-30 |
| Authors | DemoJudy |
| Reviewers | DemoHeidi, DemoNina |

## Context

Partners authenticate with a static API key sent in a header. Keys never expire, grant access to everything the partner account can do, and leak: in 2025 we rotated 19 keys found in public code repositories. A key cannot be limited to reading orders or to one integration.

## Decision

Partner applications authenticate with **OAuth 2.0 client credentials** and short-lived access tokens.

* Each partner can register several applications, each with its own client id, secret and scopes ([RFC-040](@RFC-040), [SPEC-031](@SPEC-031)).
* Access tokens are signed JWTs, valid for 15 minutes, issued by `identity-svc`; `api-gateway` verifies them without a network call.
* Client secrets are shown once, stored hashed (Argon2id), and can be rotated with a 24-hour overlap.
* Static keys stop working for `/v2`; they keep working for `/v1` until it is retired ([ADR-044](@ADR-044)).

```http
POST /oauth/token HTTP/1.1
Host: auth.example.com
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&scope=orders.read%20inventory.write
```

## Options considered

| Option | Token lifetime | Scopes | Leak impact | Partner effort | Verdict |
| -- | -- | -- | -- | -- | -- |
| **OAuth 2.0 client credentials** | **15 min** | **yes** | **secret rotates, tokens expire** | **standard libraries** | **Chosen** |
| Scoped API keys | unlimited | yes | key works until revoked | none | Leaked keys stay valid |
| Mutual TLS client certificates | certificate lifetime | no | low | high | Too hard for small partners |
| Static keys (today) | unlimited | no | full account | none | The problem we have |

## Consequences

* A leaked token is useful for 15 minutes; a leaked secret can be rotated without downtime.
* `identity-svc` becomes critical for partner traffic; tokens are cached by partners, so a 10-minute outage of the token endpoint affects few calls.
* Every SDK handles token refresh ([SPEC-044](@SPEC-044)).

## Follow-up

- [X] Token endpoint and application registration in Seller Hub
- [X] Scope checks in `api-gateway`
- [X] Secret scanning alerts for leaked client secrets

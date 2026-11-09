| Status | Stable |
| -- | -- |
| Version | 2.1 |
| Updated | 2026-02-09 |
| Owner | DemoNina |
| Applies to | Partner apps calling the public API |

## Overview

Partner apps authenticate with the OAuth 2.0 client credentials grant ([ADR-017](@ADR-017), [RFC-040](@RFC-040)). An app exchanges its client id and secret for an access token, then sends the token as a bearer token on every request. Tokens are limited to the scopes the app was granted.

## Getting a token

```http
POST /oauth/token HTTP/1.1
Host: api.example.com
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=dm_test_client_7Q2&client_secret=dm_test_secret_xxxxxxxx&scope=orders%3Aread%20orders%3Awrite
```

```json
{
  "access_token": "eyJhbGciOiJFUzI1NiIsImtpZCI6IjIwMjYtMDIifQ.eyJzdWIiOiJhcHBfN1EyIn0.c2lnbmF0dXJl",
  "token_type": "Bearer",
  "expires_in": 1800,
  "scope": "orders:read orders:write"
}
```

| Parameter | Required | Notes |
| -- | -- | -- |
| `grant_type` | yes | Always `client_credentials` |
| `client_id` | yes | From the partner portal |
| `client_secret` | yes | Shown once when created; two may be active during rotation |
| `scope` | no | Space-separated; defaults to all scopes granted to the app |

Tokens are valid for 30 minutes. Request a new one when less than 5 minutes remain; do not request one per API call. The token endpoint allows 30 requests per minute per app.

## Scopes

| Scope | Endpoints |
| -- | -- |
| `products:read` | `GET /products`, `GET /products/{id}` |
| `products:write` | `POST /products`, `PATCH /products/{id}`, `DELETE /products/{id}` |
| `inventory:read` | `GET /inventory` |
| `inventory:write` | `PATCH /inventory/{variant_id}`, `POST /import-jobs` |
| `orders:read` | `GET /orders`, `GET /orders/{id}`, `GET /orders/{id}/shipments` |
| `orders:write` | `POST /orders/{id}/confirm`, `POST /orders/{id}/shipments` |
| `refunds:write` | `POST /refunds` (needs approval in the partner portal) |
| `webhooks:manage` | `/webhook-subscriptions` |

## Token contents

The token is a JWT signed with ES256. Keys are published at `https://api.example.com/oauth/jwks.json`; the key id changes every 3 months, and the previous key stays published for 24 hours after a change.

| Claim | Meaning |
| -- | -- |
| `sub` | The app id, for example `app_7Q2` |
| `partner` | The partner account id |
| `scope` | Granted scopes, space-separated |
| `exp`, `iat` | Expiry and issue time |
| `jti` | Token id, used to revoke a token |

## Flow

```mermaid
sequenceDiagram
    participant A as Partner app
    participant I as identity-svc
    participant G as api-gateway
    A->>I: POST /oauth/token
    I-->>A: access_token, expires_in 1800
    loop Until the token expires
        A->>G: request with Authorization Bearer
        G->>G: check signature, exp, scope, revocation list
        G-->>A: response
    end
    A->>I: POST /oauth/token (new token)
```

## Errors

| Status | Problem type | When |
| -- | -- | -- |
| `400` | `invalid-grant-request` | Missing or wrong parameters at the token endpoint |
| `401` | `invalid-client` | Unknown client id or wrong secret |
| `401` | `token-expired` | The bearer token has expired |
| `403` | `insufficient-scope` | The token lacks the scope; the `required_scope` field names it |
| `429` | `rate-limited` | Too many token requests |

## Version history

| Version | Date | Change |
| -- | -- | -- |
| 2.0 | 2025-11-18 | Client credentials and scopes for v2 |
| 2.1 | 2026-02-09 | Two active secrets during rotation; ES256 instead of RS256 |

| Status | Implemented |
| -- | -- |
| Date | 2025-08-13 |
| Authors | DemoHeidi |
| Reviewers | DemoJudy, DemoKen |
| Plan | [RFC-031 Webhooks with retries and signatures](@RFC-031) |

## Context

Webhooks are plain HTTPS POSTs. A partner cannot tell whether a request came from DemoMart, and two partners reported fake "order paid" calls in 2025 that made them ship goods. Replayed requests are also possible: nothing in a webhook says when it was sent.

## Decision

Every webhook carries an **HMAC-SHA256 signature** over a timestamp and the raw body, with a secret per endpoint.

* Header: `DemoMart-Signature: t=<unix seconds>,v1=<hex digest>`, where the digest covers `<t>.<raw body>`.
* Receivers should reject a timestamp older than 5 minutes.
* Secrets are 32 random bytes, shown once, rotatable with a 24-hour overlap during which two `v1` values are sent.
* Delivery rules are in [SPEC-039](@SPEC-039); event types in [SPEC-040](@SPEC-040).

```go
func Verify(secret []byte, header string, body []byte, now time.Time) error {
    t, sigs, err := parse(header)
    if err != nil {
        return err
    }
    if now.Sub(time.Unix(t, 0)) > 5*time.Minute {
        return ErrTooOld
    }
    mac := hmac.New(sha256.New, secret)
    fmt.Fprintf(mac, "%d.", t)
    mac.Write(body)
    want := mac.Sum(nil)
    for _, s := range sigs {
        if hmac.Equal(want, s) {
            return nil
        }
    }
    return ErrBadSignature
}
```

## Options considered

| Option | Receiver effort | Replay protection | Key handling | Verdict |
| -- | -- | -- | -- | -- |
| **HMAC-SHA256 with timestamp** | **10 lines in any language** | **yes, 5 minutes** | **shared secret per endpoint** | **Chosen** |
| Asymmetric signatures (Ed25519) | a library | yes | public key, no secret to leak | Fewer partners can implement it; may come as `v2` |
| Mutual TLS | high | no | certificates | Too hard for small partners |
| Source IP allow-lists | low | no | IP ranges change | Spoofable through proxies, brittle |

## Consequences

* Partners can trust webhooks; the SDKs verify signatures out of the box.
* [RN-040](@RN-040) found that 23 % of partner code samples compare signatures with a non-constant-time comparison; the documentation now shows the safe way.

## Follow-up

- [X] Sign all webhooks
- [X] Verification helpers in the three SDKs
- [ ] Offer Ed25519 signatures as `v2`

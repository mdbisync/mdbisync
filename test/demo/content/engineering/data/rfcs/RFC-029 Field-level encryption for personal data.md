| Status | Implemented |
| -- | -- |
| Created | 2025-11-25 |
| Authors | DemoPeggy |
| Reviewers | DemoCarol, DemoGrace, DemoMike |
| Target | Q2 2026 |
| Decision | [ADR-028 Encrypt personal data at the field level](@ADR-028) |

## Summary

Encrypt personal data fields (names, addresses, phone numbers) in the application before they reach the database, with per-tenant data keys wrapped by a key management service, so backups, replicas and analytics copies hold only ciphertext.

## Motivation

* Disk encryption protects against a stolen disk, not against a leaked backup, a broad database grant or a copy in the analytics store.
* 23 tables in 6 databases hold personal data; 14 roles can read them.
* Deleting a buyer's data means finding every copy, including backups kept 90 days ([RFC-021](@RFC-021)). Destroying a key is faster than finding copies.

## Proposal

### Envelope encryption

Each buyer and each seller account gets a data key. Data keys are wrapped by a key encryption key in the cloud key management service and stored next to the account. Fields are encrypted with AES-256-GCM.

@@picture:rfc-029-keys@@

The key hierarchy is in [SPEC-029](@SPEC-029).

### Fields

| Table | Fields encrypted | Searchable by |
| -- | -- | -- |
| `buyers` | name, phone | none |
| `addresses` | name, line 1, line 2, phone | postal code (kept in clear, coarse) |
| `orders` | delivery name, delivery address | none |
| `sellers` | legal name, bank account | blind index of legal name |

Email addresses are used for sign-in and stay in `identity-svc`, protected by its own controls.

### Library

```go
type Sealed struct {
    KeyID      string `json:"k"`
    Nonce      []byte `json:"n"`
    Ciphertext []byte `json:"c"`
}

addr.Line1, err = crypt.Seal(ctx, buyer.KeyID, []byte(input.Line1))
```

Data keys are cached in memory for 5 minutes per pod, so most requests make no call to the key management service.

### Deleting a buyer

Deleting a buyer destroys their data key. Every copy of their encrypted fields, in backups and replicas included, becomes unreadable at once.

## Alternatives

| Option | Protects backups | Deletion | Cost | Why not |
| -- | -- | -- | -- | -- |
| Disk encryption only (today) | no | find every copy | none | Not enough |
| Transparent column encryption in the database | partly | find every copy | low | Keys live with the database |
| Tokenisation service | yes | delete the token | high: one call per field read | Latency, new critical service |
| **Application-level envelope encryption** | **yes** | **destroy the key** | **medium** | Chosen; overhead in [RN-028](@RN-028) |

## Rollout

- [X] Library and key service integration
- [X] New writes encrypted in `orders-svc` and `identity-svc`
- [X] Background re-encryption of 61 million existing rows
- [X] Clear-text columns dropped
- [X] Deletion by key destruction in the account deletion flow

## Open questions

* Should sellers' bank accounts move to `demo-pay` entirely? Discussed separately in [SPEC-057](@SPEC-057).

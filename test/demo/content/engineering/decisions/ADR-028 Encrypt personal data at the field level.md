| Status | Accepted |
| -- | -- |
| Date | 2025-12-26 |
| Authors | DemoOscar |
| Reviewers | DemoCarol, DemoJudy |
| Plan | [RFC-029 Field-level encryption for personal data](@RFC-029) |
| Evidence | [RN-028 Cost of field-level encryption](@RN-028) |

## Context

Buyer names, addresses and phone numbers sit in plain text in four databases, in their backups, and in every copy made for debugging. Disk encryption protects against stolen disks, not against a leaked backup or an over-broad database role. A data protection review in November asked us to limit who can read personal data and to be able to erase it everywhere.

## Decision

Personal fields are **encrypted in the application** before they reach the database, with a key per buyer.

* Fields: name, delivery and billing address, phone number, email address. Order contents and amounts stay in plain text.
* Envelope encryption: AES-256-GCM data keys per buyer, wrapped by a key-encryption key in the cloud key service ([SPEC-029](@SPEC-029)).
* Erasing a buyer deletes their data key; their fields become unreadable in every database and backup at once.
* Searching by email uses a keyed HMAC of the normalised address stored next to the ciphertext.

```go
type Address struct {
    Line1      kit.Sealed `db:"line1"`
    PostalCode kit.Sealed `db:"postal_code"`
    City       kit.Sealed `db:"city"`
    Country    string     `db:"country"` // not personal on its own; kept for tax and shipping rules
}
```

## Options considered

| Option | Readable in a leaked backup | Erasure | Added p99 latency ([RN-028](@RN-028)) | Verdict |
| -- | -- | -- | -- | -- |
| **Application-level, key per buyer** | **no** | **delete one key** | **1.4 ms** | **Chosen** |
| Database column encryption, one key | no | rewrite every copy | 0.6 ms | Erasure needs backup rewrites |
| Tokenisation service | no | delete tokens | 4.2 ms | A new critical service in every request |
| Disk encryption only (today) | yes | rewrite every copy | 0 | The problem we have |

## Consequences

* Support tools and analytics see personal fields only through a decryption service with an audit log.
* Sorting and range queries on personal fields are no longer possible; none of our features need them.

## Follow-up

- [X] Sealed types in the Go kit
- [ ] Encrypt fields in `identity-svc` and `orders-svc`
- [ ] Erasure job using key deletion

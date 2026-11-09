| Status | Accepted |
| -- | -- |
| Date | 2026-09-09 |
| Authors | DemoOscar |
| Reviewers | DemoFrank, DemoJudy |
| Specification | [SPEC-010 Secret rotation protocol](@SPEC-010) |

## Context

Secrets (database passwords, provider API keys, signing keys) are Kubernetes secrets created from encrypted files in the environments repository ([ADR-008](@ADR-008)). Rotating one means re-encrypting a file, a commit and a restart of every pod that uses it. Of 214 secrets, 131 had not been rotated for over a year, and decrypting the files needs a key that eleven people hold.

## Decision

Secrets live in the cloud provider's **managed secret store** and are read by services at runtime through workload identity.

* Each service's identity can read only its own secrets; no human reads production secrets without a logged break-glass request.
* Services fetch secrets at start and refresh them every 5 minutes; the Go kit handles it.
* Rotation follows [SPEC-010](@SPEC-010): a new version is added, both versions are valid during an overlap, then the old one is disabled. Database passwords rotate every 30 days automatically.
* The encrypted files in the environments repository are removed.

```yaml
secrets:
  - name: orders-db-password
    rotation: 30d
    consumers: [orders-svc]
  - name: card-processor-a-api-key
    rotation: manual
    consumers: [demo-pay]
```

## Options considered

| Option | Secrets older than a year | People who can read production secrets | Rotation effort | Verdict |
| -- | -- | -- | -- | -- |
| **Managed secret store, workload identity** | **0 after migration** | **0 (break-glass only)** | **automatic for databases** | **Chosen** |
| Self-hosted secrets server | 0 | 2 operators | automatic | One more critical system to run |
| Encrypted files in Git (today) | 131 | 11 | commit and restart | The problem we have |

## Consequences

* Rotations stop being events; most happen without anyone noticing.
* Services depend on the secret store at start; cached values let running pods survive an outage.

## Follow-up

- [X] Workload identity for every service
- [ ] Move all 214 secrets
- [ ] Remove the encrypted files and the decryption key

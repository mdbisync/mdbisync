| Status | Implemented |
| -- | -- |
| Date | 2025-01-17 |
| Authors | DemoBob |
| Reviewers | DemoAlice, DemoFrank |

## Context

DemoMart's twelve services run on virtual machines built from images, one service per machine group, deployed by shell scripts. A deploy takes 25 minutes, a machine group runs at 18 % CPU on average, and scaling up for a sale means ordering machines two days ahead. Three people know how the scripts work.

## Decision

We run all stateless services on the cloud provider's **managed Kubernetes** service, one cluster per region and environment.

* The provider runs the control plane; we run node pools: `general` (8 vCPU, 32 GB), `memory` (8 vCPU, 64 GB) and `batch` (spot instances, see [RFC-014](@RFC-014)).
* Databases, Kafka and Redis stay on managed services outside the cluster.
* Every service ships as a container image and a manifest in the format of [SPEC-001](@SPEC-001).
* Deploys go through Argo CD ([ADR-008](@ADR-008)); cluster resources are created with Terraform ([ADR-009](@ADR-009)).

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: catalog-svc
spec:
  replicas: 4
  template:
    spec:
      containers:
        - name: catalog-svc
          image: registry.example.com/catalog-svc:2025.01.3
          resources:
            requests: { cpu: 500m, memory: 512Mi }
            limits: { memory: 1Gi }
```

## Options considered

| Option | Deploy time | Average utilisation | Scale-up time | Operations | Verdict |
| -- | -- | -- | -- | -- | -- |
| **Managed Kubernetes** | **4 min** | **55 % expected** | **2 min** | **node pools only** | **Chosen** |
| Self-managed Kubernetes | 4 min | 55 % expected | 2 min | control plane too | Too much to run for our size |
| Serverless containers | 2 min | not applicable | seconds | none | Cold starts ([RN-002](@RN-002)), no long-lived consumers |
| Virtual machines (today) | 25 min | 18 % | 2 days | scripts | The problem we have |

## Consequences

* Compute cost drops by an estimated 35 % through bin packing; [RN-012](@RN-012) tracks the real number.
* Every engineer needs basic Kubernetes knowledge; the [golden path](@RFC-011) hides most of it.
* Health checks become mandatory ([SPEC-002](@SPEC-002)).

## Follow-up

- [X] Clusters in both regions, staging and production
- [X] Move the twelve services, lowest risk first
- [X] Switch off the old machine groups
- [X] Remove the deploy scripts

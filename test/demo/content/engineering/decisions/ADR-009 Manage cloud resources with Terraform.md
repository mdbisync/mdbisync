| Status | Implemented |
| -- | -- |
| Date | 2025-04-13 |
| Authors | DemoFrank |
| Reviewers | DemoBob, DemoCarol |

## Context

Databases, buckets, queues and network rules were created by hand in the cloud console. An audit in March found 61 resources nobody could explain, 14 of them costing money, and staging differs from production in 23 settings. Recreating a region from scratch would take weeks.

## Decision

All cloud resources are defined in **Terraform**, in the `infrastructure` repository, applied only from CI.

* One root module per region and environment; shared modules for a service database, a Kafka topic set, a bucket and a cluster node pool.
* State lives in a versioned bucket with locking; nobody applies from a laptop.
* Every plan is posted to the pull request; production applies need two approvals.
* Resources carry the cost labels of [SPEC-014](@SPEC-014).

```hcl
module "orders_db" {
  source         = "../modules/service-postgres"
  name           = "orders"
  version        = "16"
  tier           = "db-custom-8-32768"
  high_available = true
  pitr_days      = 14
  labels = {
    service = "orders-svc"
    team    = "checkout"
  }
}
```

## Options considered

| Option | Coverage of our provider | Plan before apply | Team experience | Verdict |
| -- | -- | -- | -- | -- |
| **Terraform** | **all 41 resource types we use** | **yes** | **9 of 22** | **Chosen** |
| Pulumi in Go | all | yes | 2 of 22 | Fewer people know it |
| Provider's own templates | 37 of 41 | partial | 3 of 22 | Locks us to one provider's tool |
| Console by hand (today) | all | no | everyone | The problem we have |

## Consequences

* Importing the 380 existing resources took about three weeks.
* Changes take longer than a console click but are reviewed and reversible.
* Unexplained resources show up as drift in the nightly plan.

## Follow-up

- [X] Import all production resources
- [X] Delete the 61 unexplained resources after a two-week notice
- [X] Nightly drift check in CI

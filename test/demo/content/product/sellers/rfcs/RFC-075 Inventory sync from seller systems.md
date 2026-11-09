| Status | Implemented |
| -- | -- |
| Created | 2025-12-02 |
| Authors | DemoKen |
| Reviewers | DemoNina, DemoIvan |
| Target | Q1 2026 |
| Evidence | [RN-072 Inventory sync errors by integration](@RN-072) |

## Summary

Let seller systems push stock levels to DemoMart as versioned absolute values, confirm each change, and receive order reservations back as webhooks, so DemoMart and the seller's own system agree on stock within seconds.

## Motivation

Sellers who also sell in their own shop keep stock in their own system. Today they upload a CSV or the system polls our inventory endpoints every 15 minutes. In October 2025:

* 1.9 % of orders from sellers on polling or CSV were for items already sold elsewhere, and each one ended in a cancellation.
* Updates arrived out of order: a stock level of 5 sent before a level of 4 could land after it, and the old value won.
* 42 of every 10,000 CSV updates were rejected, mostly for unknown SKUs, and the seller learned about it the next day ([RN-072](@RN-072)).

## Proposal

@@picture:rfc-075-sync@@

### Push, with versions

A seller system sends absolute stock levels, never deltas, each with a version that increases per SKU. DemoMart applies a level only if its version is higher than the stored one, so a late update can never overwrite a newer one. The protocol is [SPEC-080](@SPEC-080); the endpoint is part of the [inventory API](@SPEC-038).

```json
{
  "updates": [
    { "sku": "OAK-SHELF-120", "available": 14, "version": 1767225600123 },
    { "sku": "OAK-SHELF-90", "available": 0, "version": 1767225600124 }
  ]
}
```

The response confirms each SKU with `applied`, `stale` (an older version) or `unknown_sku`, so the seller system can act at once.

### Reservations back to the seller

When a buyer pays, [stock reservation](@SPEC-054) holds the items and DemoMart sends an `inventory.reserved` webhook ([SPEC-040](@SPEC-040)). The seller system lowers its own stock; its next push carries the lower level with a higher version.

### Limits

Up to 1,000 SKUs per request and 20 requests per second per seller ([rate limit headers](@SPEC-034)). Requests carry an idempotency key ([SPEC-035](@SPEC-035)).

## Alternatives

| Option | Oversold orders | Seller effort | Why not |
| -- | -- | -- | -- |
| Poll every 15 minutes (today) | 1.9 % | none | The problem |
| Poll every minute | about 0.6 % (estimate) | none | 15 times the read load, still a gap |
| Deltas ("sold 2") instead of levels | low | small | A lost or repeated delta drifts forever |
| **Versioned absolute levels plus reservation webhooks** | **under 0.2 % (target)** | **small** | Chosen |

## Rollout

- [X] Protocol and endpoint in the sandbox ([SPEC-043](@SPEC-043))
- [X] The two most used shop platform plugins switched to push
- [X] Oversold rate for push sellers measured: 0.12 % in February 2026
- [X] CSV upload shows rejected SKUs immediately instead of the next day
- [ ] Polling endpoint marked deprecated in the API ([SPEC-042](@SPEC-042))

## Open questions

* Do we need a full "replace all stock" call for sellers who reset their system? For now, a seller can push every SKU with a new version.

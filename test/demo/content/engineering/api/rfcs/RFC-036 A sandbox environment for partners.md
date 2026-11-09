| Status | Accepted |
| -- | -- |
| Created | 2025-11-04 |
| Authors | DemoNina |
| Reviewers | DemoFrank, DemoLaura, DemoGrace |
| Target | Q1 2026 |
| Decision | Accepted at the API review, 2025-11-20 |

## Summary

Give every partner a sandbox: a separate API host with test keys, synthetic data, payments that never move money, and controls to trigger webhooks and order states on demand. Production and sandbox share the same code and OpenAPI document.

## Motivation

Today partners test against production with a test seller account. That has three problems:

* Test orders go through real payment authorisation, so partners use real cards and refund themselves; finance reversed 1,140 such payments in Q3 2025.
* Partners cannot make an order reach "delivered" or "refunded" without waiting days for real carriers.
* A partner's broken integration can send real webhooks to real buyers' sellers.

## Proposal

### Shape

@@picture:rfc-036-sandbox@@

* Host `sandbox.api.example.com`, the same paths as production.
* Keys start with `dm_test_`; production keys with `dm_live_`. A key works only on its own host.
* One sandbox per partner, created with the partner account, filled with 200 synthetic products, 50 orders in various states and 3 test sellers.
* `demo-pay` runs with the payment processor's test mode; test card numbers decide the outcome (success, soft decline, 3-D Secure challenge).
* A simulation endpoint moves an order to any state and fires the matching webhooks:

```sh
curl -X POST https://sandbox.api.example.com/v2/sandbox/orders/ord_01JA0T6Z/simulate \
  -H "Authorization: Bearer dm_test_8f2c41" \
  -H "Idempotency-Key: 5b2d0e0a-77c4-4f1e-9a51-6f0d2c11e7b3" \
  -H "Content-Type: application/json" \
  -d '{ "to_state": "delivered" }'
```

### Isolation

Sandboxes run in their own Kubernetes namespace and database cluster. They never call carriers, tax services or notification providers; those are replaced by fakes that answer the way the real ones do. Data is reset on request and deleted after 90 days without use. Limits are those of production ([SPEC-034](@SPEC-034)), so retry code is exercised. The full contract is in [SPEC-043](@SPEC-043).

## Alternatives

| Option | Real payments | Order states on demand | Cost per month | Why not |
| -- | -- | -- | -- | -- |
| Test sellers in production (today) | yes | no | none | Real money and real webhooks |
| A mock server from the OpenAPI document | no | no state | very low | No behaviour, no webhooks |
| **A full sandbox per partner** | **no** | **yes** | **about 2,300 USD** | Chosen |

## Rollout

- [X] Sandbox namespace and database cluster
- [X] Synthetic data generator for products and orders
- [ ] Simulation endpoints for orders, shipments and refunds
- [ ] Sandbox key issued with every new partner account
- [ ] Stop issuing test sellers in production

## Open questions

* Should sandbox data be shared between a partner's developers or be per developer? Starting with per partner.

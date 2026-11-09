| Status | Stable |
| -- | -- |
| Version | 1.3 |
| Updated | 2026-07-20 |
| Owner | DemoNina |
| Applies to | Seller Hub, its GraphQL API, partner apps acting for a seller |

## Overview

A seller account has members ([SPEC-078](@SPEC-078)); each member has exactly one role. A role is a fixed set of permissions; sellers cannot define their own roles. Partner apps get permissions through OAuth scopes ([SPEC-031](@SPEC-031)) that map onto the same permissions.

## Roles

| Role | For | Per account |
| -- | -- | -- |
| Owner | The person who opened the account | exactly 1 |
| Admin | Runs the account day to day | any |
| Catalog editor | Lists products, prices and stock | any |
| Fulfilment | Ships orders and handles returns | any |
| Finance | Payouts, statements and invoices | any |
| Viewer | Reads everything, changes nothing | any |

## Permission matrix

| Permission | Owner | Admin | Catalog editor | Fulfilment | Finance | Viewer |
| -- | -- | -- | -- | -- | -- | -- |
| View listings and orders | yes | yes | yes | yes | yes | yes |
| Create and edit listings | yes | yes | yes | no | no | no |
| Use the bulk editor | yes | yes | yes | no | no | no |
| Change prices | yes | yes | yes | no | no | no |
| Buy shipping labels | yes | yes | no | yes | no | no |
| Respond to return requests | yes | yes | no | yes | no | no |
| View payouts and statements | yes | yes | no | no | yes | yes |
| Change the payout account | yes | no | no | no | no | no |
| Invite and remove members | yes | yes | no | no | no | no |
| Connect partner apps | yes | yes | no | no | no | no |
| Close the account | yes | no | no | no | no | no |

Changing the payout account also needs a second confirmation from the owner and a 48-hour delay before the next payout uses it.

## In the API

Every field and mutation declares the permission it needs; the gateway checks it before resolving:

```graphql
directive @requires(permission: Permission!) on FIELD_DEFINITION

type Mutation {
  bulkUpdateListings(input: BulkUpdateListingsInput!): BulkUpdatePayload!
    @requires(permission: LISTINGS_WRITE)
  createShippingLabel(input: CreateShippingLabelInput!): CreateShippingLabelPayload!
    @requires(permission: LABELS_BUY)
  updatePayoutAccount(input: UpdatePayoutAccountInput!): PayoutAccount!
    @requires(permission: PAYOUT_ACCOUNT_WRITE)
}
```

A request without the permission fails with the code `forbidden` and names the missing permission, never the role.

## Scopes for partner apps

| OAuth scope | Permissions |
| -- | -- |
| `listings:read` | View listings and orders |
| `listings:write` | Create and edit listings, change prices, use bulk operations |
| `inventory:write` | Change stock ([SPEC-080](@SPEC-080)) |
| `fulfilment:write` | Buy shipping labels, respond to return requests |
| `payouts:read` | View payouts and statements |

No scope gives a partner app the right to change the payout account or to manage members.

## Version history

| Version | Date | Change |
| -- | -- | -- |
| 1.0 | 2025-10-20 | Roles with the split of members from accounts |
| 1.1 | 2026-02-02 | Partner app scopes |
| 1.2 | 2026-07-06 | Buy shipping labels |
| 1.3 | 2026-07-20 | Bulk editor permission; schema directive with GraphQL ([ADR-043](@ADR-043)) |

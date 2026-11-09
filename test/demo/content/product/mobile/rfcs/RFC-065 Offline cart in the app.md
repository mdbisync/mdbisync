| Status | Implemented |
| -- | -- |
| Created | 2025-11-20 |
| Authors | DemoNina |
| Reviewers | DemoOscar, DemoPeggy, DemoFrank |
| Target | App 5.2, Q1 2026 |
| Decision | [ADR-024 Build the mobile app natively in Kotlin and Swift](@ADR-024) |

## Summary

Let buyers add, remove and change cart lines in the DemoMart app without a connection. Changes are stored on the device first, sent to `cart-svc` when the app is online again, and merged with changes made on the web in the meantime.

## Motivation

The app calls `cart-svc` for every cart change and shows an error when the call fails. In October 2025:

* 6.8 % of "add to cart" taps failed on the first try, almost all on mobile networks in trains, lifts and basements.
* 41 % of buyers who saw that error did not try again in the same session.
* Cart screens on low-end Android waited a median of 740 ms for the server before showing the updated total.

The cart is the one screen where an optimistic local write is safe: nothing is charged until checkout, and checkout always reads the server cart ([SPEC-045](@SPEC-045)).

## Proposal

@@picture:rfc-065-offline-cart@@

### Local store

The app keeps the cart in its local SQLite database ([SPEC-074](@SPEC-074)). Every change writes the new cart line and appends an operation to an outbox table in one transaction. The cart screen reads only the local store, so it updates at once.

```kotlin
suspend fun addToCart(productId: String, variantId: String, quantity: Int) {
    db.withTransaction {
        val line = cartDao.upsert(productId, variantId, quantity)
        outboxDao.append(CartOp.Upsert(line.id, variantId, quantity, line.version))
    }
    syncScheduler.requestSoon()
}
```

### Sync

A sync worker sends queued operations in order to `PUT /v2/carts/me/lines/{lineId}` with the line's version. It runs when the app is in the foreground, when connectivity returns, and at most every 15 seconds while changes are queued.

### Merging

`cart-svc` keeps one version number per line ([SPEC-046](@SPEC-046)). An operation based on an older version than the server's is merged by these rules:

| Case | Result |
| -- | -- |
| Same line changed on two devices | The later change by server receive time wins |
| Line removed on one device, changed on the other | The removal wins |
| Product no longer sold | Line removed; the app shows a notice |
| Price changed | Server price wins; the app shows the new total |

The server answers each request with the whole merged cart, and the app replaces its local copy.

## Alternatives

| Option | Works offline | Conflicts | Effort | Why not |
| -- | -- | -- | -- | -- |
| Retry the request with backoff | no | none | small | The buyer still waits and sees errors |
| Cache the cart, block changes offline | read only | none | small | Does not fix failed taps |
| CRDT cart synced between devices | yes | merged automatically | large | More than a cart needs |
| **Local store and outbox** | **yes** | **simple rules** | **medium** | Chosen |

## Rollout

- [X] Local store and outbox behind the `offline_cart` flag ([ADR-022](@ADR-022))
- [X] Merge rules in `cart-svc`, with version per line
- [X] 10 % of Android users for two weeks
- [X] All users on iOS and Android in app 5.2
- [X] Remove the online-only code path

## Open questions

* Should saved-for-later items use the same outbox? Deferred; they change far less often.
* The guest cart has no account to merge into; it stays on the device until sign-in, as before.

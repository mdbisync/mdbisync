| Status | Stable |
| -- | -- |
| Version | 1.4 |
| Updated | 2026-06-09 |
| Owner | DemoJudy |
| Applies to | The app's router, the web shop, push notifications and emails |

## Overview

One routing table maps paths to screens. The web shop serves the same paths, so `https://www.example.com/p/8c1f2a` opens the product in the app when it is installed and on the web otherwise ([RFC-071](@RFC-071)). Push notifications use the custom scheme with the same path: `demomart://p/8c1f2a`.

## Routes

| Path | Screen id | Sign-in | Parameters | Tab |
| -- | -- | -- | -- | -- |
| `/` | `home` | no | none | Home |
| `/p/{productId}` | `product` | no | `variant` (optional) | Home |
| `/c/{categorySlug}` | `category` | no | `sort`, `page` | Home |
| `/search` | `search_results` | no | `q` (required), `filters` | Search |
| `/s/{sellerSlug}` | `seller_store` | no | none | Home |
| `/campaign/{slug}` | `campaign` | no | none | Home |
| `/cart` | `cart` | no | none | Cart |
| `/saved` | `saved` | yes | none | Saved |
| `/orders` | `orders` | yes | none | Account |
| `/orders/{orderId}` | `order_detail` | yes | none | Account |
| `/orders/{orderId}/tracking` | `tracking` | yes | none | Account |
| `/orders/{orderId}/return` | `return_request` | yes | `item` | Account |
| `/settings/notifications` | `notification_prefs` | yes | none | Account |

Paths not in the table open the home screen in the app. Paths under `/account/password`, `/help` and `/legal` are excluded from app links and always open in the browser.

## The routing file

Both apps generate their routers from `routes.json` at build time. A route has a path template, a screen id and whether it needs sign-in:

```json
{
  "version": 14,
  "routes": [
    { "path": "/p/{productId}", "screen": "product", "auth": false, "query": ["variant"] },
    { "path": "/orders/{orderId}/tracking", "screen": "tracking", "auth": true },
    { "path": "/search", "screen": "search_results", "auth": false, "query": ["q", "filters"], "required": ["q"] }
  ],
  "excluded": ["/account/password", "/help", "/legal"]
}
```

Generated Swift for one route:

```swift
case .tracking(let orderId):
    return AppRoute(tab: .account, stack: [.orders, .orderDetail(orderId), .tracking(orderId)], requiresAuth: true)
```

## Matching

1. Strip the scheme and host; only `www.example.com` and `demomart://` are accepted.
2. Match the path against templates in table order; the first match wins.
3. Validate ids: product, order and seller ids are 6 to 24 characters of `[a-z0-9_]`. An invalid id opens the home screen.
4. If the route needs sign-in and the buyer is signed out, show sign-in, then continue.
5. Build the back stack from the tab's root to the screen ([SPEC-069](@SPEC-069)).

## Domain association

| File | Served at | Content |
| -- | -- | -- |
| `apple-app-site-association` | `https://www.example.com/.well-known/` | App ids and path patterns, with the excluded paths as `NOT` patterns |
| `assetlinks.json` | `https://www.example.com/.well-known/` | Android package name and signing certificate fingerprint |

## Version history

| Version | Date | Change |
| -- | -- | -- |
| 1.0 | 2025-12-08 | Product, category, search, orders |
| 1.2 | 2026-02-03 | Tracking and campaign routes; used by push notifications |
| 1.3 | 2026-03-17 | Seller stores and returns |
| 1.4 | 2026-06-09 | Notification preferences; id validation rule |

| Status | Implemented |
| -- | -- |
| Date | 2025-10-20 |
| Authors | DemoLaura |
| Reviewers | DemoNina, DemoBob |

## Context

The web shop is a single-page application that renders in the browser. On a mid-range phone over 4G, the largest contentful paint of a product page is 4.1 s at p75, and search engines index only part of the catalog because product content appears after JavaScript runs. Organic search brings 38 % of buyers, so both numbers cost sales.

## Decision

The web shop is built with **Next.js** using server rendering, running on Node.js in the Kubernetes clusters.

* Product, category and search pages render on the server and stream HTML; the cart and checkout render on the client.
* Product pages are cached at the edge for 60 seconds ([ADR-035](@ADR-035)).
* Pages call `api-gateway`'s internal routes, never services directly.
* Performance budgets: LCP under 2.5 s and total JavaScript under 180 KB compressed on product pages, checked in CI with lab runs.

```ts
export default async function ProductPage({ params }: { params: { id: string } }) {
  const product = await catalog.getProduct(params.id, { revalidate: 60 });
  return (
    <ProductLayout product={product}>
      <Gallery images={product.images} />
      <AddToCart productId={product.id} />
    </ProductLayout>
  );
}
```

## Options considered

| Option | LCP p75 on product pages (prototype) | Indexed product pages | Team experience | Verdict |
| -- | -- | -- | -- | -- |
| **Next.js with server rendering** | **1.9 s** | **all** | **React, 7 of 8** | **Chosen** |
| Remix | 2.0 s | all | React, 7 of 8 | Smaller ecosystem for our needs |
| Static generation of 4.2 million pages | 1.4 s | all | React | Build times of hours; prices change all day |
| Client rendering (today) | 4.1 s | about 60 % | React | The problem we have |

## Consequences

* The web shop becomes a server workload with its own scaling and SLOs ([ADR-033](@ADR-033)).
* Shared UI pieces use the design tokens of [ADR-025](@ADR-025).

## Follow-up

- [X] Product and category pages on Next.js
- [X] Search pages
- [X] Retire the old single-page shop

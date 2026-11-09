| Status | Complete |
| -- | -- |
| Date | 2025-06-20 |
| Authors | DemoJudy, DemoIvan |
| Led to | [RFC-032 Cursor pagination for list endpoints](@RFC-032) |

## Question

Why do deep pages of `GET /v1/products` time out on large catalogs, and would keyset (cursor) pagination fix it without new indexes?

## Method

* A copy of the catalog database with the largest seller's 420,000 products, on the production instance size.
* `GET /v1/products?limit=100&offset=N` against the copy, for N from 0 to 320,000; 200 requests per depth.
* The same pages read with a keyset query on `(updated_at, id)`, which already had an index.
* To measure consistency, a full scan of 420,000 products while a replay of a busy afternoon's writes ran against the same database.

## Results

@@picture:rn-031-latency@@

@@table:rn-031-latency@@

At 320,000 skipped items the offset query hit the gateway's 10-second timeout on every request; the chart shows the timeout.

@@csv:rn-031-latency@@

The query plans show why:

```sql
-- Offset: reads and discards every skipped row
Limit (rows=100)
  -> Index Scan using products_updated_at_id on products (rows=80100)

-- Keyset: starts at the last row of the previous page
Limit (rows=100)
  -> Index Scan using products_updated_at_id on products (rows=100)
       Index Cond: ((updated_at, id) > ('2025-06-19 08:14:03', 'prd_01J8X4K2'))
```

## Findings

* **Offset cost grows with depth.** p95 rises from 45 ms on the first page to 2,900 ms at 80,000 skipped items and times out beyond about 300,000.
* **Cursor cost is flat**: 42 to 46 ms at every depth, with the existing index.
* **Offsets drift under writes.** During the scan with concurrent writes, 0.4 % of products were returned twice or not at all. The keyset scan returned every product exactly once, and products updated during the scan appeared again at the end, which is what partners doing incremental reads want.
* Partners never jump to a page number: all 12 v1 client libraries we found scan from the first page.

## Recommendation

Use cursor pagination with an opaque token for every list in v2 ([RFC-032](@RFC-032), [SPEC-033](@SPEC-033)). Keep the sort keys indexed; no other schema change is needed.

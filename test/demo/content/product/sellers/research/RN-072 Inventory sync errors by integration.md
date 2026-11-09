| Status | Complete |
| -- | -- |
| Date | 2025-11-18 |
| Authors | DemoKen, DemoIvan |
| Led to | [RFC-075 Inventory sync from seller systems](@RFC-075) |

## Question

How often do stock updates from sellers' own systems fail or arrive too late, and does it depend on how the seller connects?

## Method

* All stock updates received in September and October 2025: 61 million updates from 9,800 sellers.
* Five ways of connecting: CSV upload in Seller Hub, polling our [inventory endpoints](@SPEC-038), the early push endpoint used by a few partners, and two shop platform plugins (Plugin A and Plugin B).
* **Rejected update:** an update DemoMart could not apply (unknown SKU, malformed row, value out of range).
* **Oversold order:** an order for an item the seller no longer had, found when the seller cancelled with the reason "out of stock". Counted per 10,000 updates to compare connections of different volume.

## Results

@@picture:rn-072-errors@@

@@table:rn-072-errors@@

@@csv:rn-072-errors@@

@@picture:rn-072-share@@

@@table:rn-072-share@@

## Findings

* CSV uploads fail most: 42 of every 10,000 rows are rejected, three quarters of them for SKUs that do not exist in DemoMart. The seller learns about it in a summary email the next day.
* Oversold orders follow the delay between a sale elsewhere and our update. Polling every 15 minutes leaves 6.1 per 10,000 updates; the push endpoint, with updates in seconds, 1.2.
* Plugin B polls every 30 minutes and has nearly the CSV's oversold rate.
* Out-of-order updates are a hidden cause: 0.3 % of polled updates carried an older level than one already applied, and the older level won because we keep the last write.
* 59 % of sellers connect by CSV or polling, the two worst methods.

> [!NOTE]
> At 1.9 % of their orders, oversold orders for CSV and polling sellers cost about 2,600 cancellations a month, each a refund and a likely lost buyer.

## Recommendation

Make push with versioned absolute levels the standard way to connect, send reservations back by webhook, and report rejected rows in the response instead of the next day. Proposed in [RFC-075](@RFC-075); protocol in [SPEC-080](@SPEC-080).

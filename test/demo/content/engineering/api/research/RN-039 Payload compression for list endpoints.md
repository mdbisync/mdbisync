| Status | Complete |
| -- | -- |
| Date | 2025-10-21 |
| Authors | DemoKen |
| Led to | Compression on by default in [SPEC-030](@SPEC-030) |

## Question

List responses of up to 200 products are large. Should the gateway compress them, with gzip or Brotli, and does it make field selection unnecessary?

## Method

* 50 real `GET /v2/products?limit=200` responses from the v2 beta, median size 412 KB uncompressed.
* Compressed with gzip level 6 and Brotli level 5 at the gateway, the levels whose CPU cost stayed under 2 ms per response on our gateway instances.
* Time to last byte measured from three client locations: a data centre in the same region, a home broadband line and a mobile 4G connection.

## Results

@@picture:rn-039-size@@

@@table:rn-039-size@@

@@picture:rn-039-time@@

@@table:rn-039-time@@

@@csv:rn-039-time@@

## Findings

* **Compression shrinks list responses about eightfold:** 412 KB to 58 KB with gzip and 47 KB with Brotli. Product JSON repeats the same keys 200 times, which compresses well.
* **It matters most on slow links.** On mobile 4G, time to last byte drops from 1,180 ms to 240 ms with gzip and 205 ms with Brotli. In the data centre the difference is a few milliseconds, and Brotli is slightly slower than gzip because compressing takes longer than sending.
* **Gateway CPU rises by 4 %** with compression on for all responses over 1 KB.
* **Field selection would save less.** Dropping descriptions and images, the fields partners skip most often, makes uncompressed responses 46 % smaller, but compressed responses only 18 % smaller.

## Recommendation

* Compress every response over 1 KB, preferring Brotli when the client accepts it and gzip otherwise ([SPEC-030](@SPEC-030)).
* Do not add field selection to v2 for now ([RFC-030](@RFC-030), open questions).
* Make the SDKs send `Accept-Encoding: br, gzip` by default ([SPEC-044](@SPEC-044)).

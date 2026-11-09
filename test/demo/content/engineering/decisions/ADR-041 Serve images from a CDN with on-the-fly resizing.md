| Status | Implemented |
| -- | -- |
| Date | 2026-06-20 |
| Authors | DemoLaura |
| Reviewers | DemoNina, DemoBob |
| Supersedes | [ADR-035 Cache product pages at the edge for 60 seconds](@ADR-035) |

## Context

Sellers upload product photos of up to 20 MB. A nightly job makes six fixed sizes in JPEG, stores them in a bucket and the web shop serves them through a separate edge cache from product pages. Images make up 71 % of the bytes of a product page, the app needs sizes the job does not make, and a new photo appears only the next day. Product pages themselves use a fixed 60-second cache ([ADR-035](@ADR-035)) on another edge.

## Decision

Images and product pages are served by **one CDN**. Images are resized and converted **on the fly at the edge**; product pages are cached until a product event purges them.

* Image URLs carry the transformation: `https://img.example.com/p/<image id>?w=640&q=75`; the CDN negotiates AVIF, WebP or JPEG from the `Accept` header.
* Allowed widths: 160, 320, 480, 640, 960, 1280, 1920; other values round up, so the cache stays small.
* Originals stay in the bucket; nothing is resized in advance.
* Product pages carry a surrogate key per product; `catalog-svc`'s product events trigger a purge. A page lives up to 24 hours otherwise.

```http
GET /p/3c1f9e?w=640&q=75 HTTP/1.1
Host: img.example.com
Accept: image/avif,image/webp,*/*

HTTP/1.1 200 OK
Content-Type: image/avif
Cache-Control: public, max-age=31536000, immutable
```

## Options considered

| Option | Median image bytes on a product page | New photo visible after | Price freshness on pages | Verdict |
| -- | -- | -- | -- | -- |
| **One CDN, edge resizing, event purges** | **410 KB** | **seconds** | **seconds** | **Chosen** |
| Edge resizing, keep 60 s page cache | 410 KB | seconds | up to 90 s | Page cache stays stale and separate |
| More sizes in the nightly job | 900 KB | next day | up to 90 s | Does not fix freshness |
| Nightly job and two edges (today) | 1.4 MB | next day | up to 90 s | The problem we have |

## Consequences

* Product pages are 1 MB lighter at the median; [RN-064](@RN-064) shows the same for the app.
* The nightly resize job and the second edge are switched off.
* Purges depend on product events reaching the CDN; a failed purge leaves a page stale for at most 24 hours.

## Follow-up

- [X] Image URLs in the web shop and app
- [X] Surrogate keys and purges on product pages
- [X] Retire the resize job and the old edge cache

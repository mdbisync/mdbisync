| Status | Complete |
| -- | -- |
| Date | 2026-02-20 |
| Authors | DemoKen |
| Led to | [RFC-070 Progressive image formats in the app](@RFC-070) |

## Question

How much data and time would the app save by loading product images as WebP or AVIF instead of JPEG, and what does decoding cost on slow devices?

## Method

* 1,000 product images from the catalog, resized by the image CDN ([ADR-041](@ADR-041)) to the sizes the app shows.
* Quality per format chosen so the median SSIM against the original matches JPEG at quality 80 (SSIM 0.962).
* Data per session: a replay of the median browsing session, 42 product images in lists and on product pages.
* Decode time: 500 decodes of one 800 by 800 image on the low-end Android reference device, with the platform decoders the app uses.

## Results

@@picture:rn-064-data-usage@@

@@table:rn-064-data-usage@@

@@csv:rn-064-data-usage@@

@@picture:rn-064-decode@@

@@table:rn-064-decode@@

## Findings

* WebP saves a third of the image data (9.6 MB to 6.4 MB per session), AVIF more than half (4.1 MB).
* On recent devices all three formats decode in under 15 ms, so AVIF is the clear choice there.
* On low-end Android, AVIF takes 38 ms per image against 11 ms for JPEG and 14 ms for WebP. While scrolling a product list, that dropped 9 % of frames in our trace, against 2 % for WebP.
* The app asks for 1,200-pixel images and scales them down. Asking for the view's size alone would save another 35 % with any format.

## Recommendation

Use AVIF on devices that decode it fast and WebP on low-end Android, and request images at their displayed size. Proposed in [RFC-070](@RFC-070), with device classes from [SPEC-076](@SPEC-076).

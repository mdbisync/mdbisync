| Status | Complete |
| -- | -- |
| Date | 2026-05-12 |
| Authors | DemoPeggy, DemoLaura |
| Led to | [RFC-066 Push notification preferences](@RFC-066) |

## Question

When should the app ask for permission to send push notifications, so that more buyers allow them and fewer turn them off later?

## Method

* New installs over 16 weeks, split into four arms of four weeks each; each arm showed the system prompt at a different moment.
* Before the prompt, the app showed one sentence about what the notifications are for, the same text in every arm.
* Android counts only Android 13 and later, where an app has to ask for permission; older versions allow notifications by default.
* Opt-in is the share of shown prompts that were allowed. Turn-off is the share of those buyers who disabled notifications within 30 days.

## Results

@@picture:rn-063-opt-in@@

@@table:rn-063-opt-in@@

@@csv:rn-063-opt-in@@

| Prompt shown | Turned off within 30 days (iOS) | Turned off within 30 days (Android) |
| -- | -- | -- |
| On first launch | 24 % | 21 % |
| After first order | 9 % | 8 % |
| After saving a product | 12 % | 10 % |
| From order tracking | 7 % | 6 % |

## Findings

* Asking on first launch, as the app does today, gets the fewest permissions: 38 % on iOS, 52 % on Android.
* Asking at a moment when a notification is obviously useful raises opt-in by 16 to 28 points. Order tracking is best: 66 % and 75 %.
* Buyers who allow notifications at such a moment keep them: only 6 to 12 % turn them off within 30 days, against 21 to 24 % for first-launch permissions.
* Fewer buyers see a prompt at all when it waits for a moment: 58 % of new installs reached one of the three moments within 30 days. The total number of buyers with notifications allowed is still 19 % higher.

## Recommendation

Ask after the first order, after saving a product and from order tracking, never on first launch, and let buyers choose categories. Specified in [RFC-066](@RFC-066); payloads in [SPEC-070](@SPEC-070).

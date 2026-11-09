| Status | Complete |
| -- | -- |
| Date | 2026-05-26 |
| Authors | DemoFrank, DemoPeggy |
| Led to | [RFC-069 Biometric sign-in](@RFC-069) |

## Question

How many buyers use biometric sign-in in the twelve weeks after its release in app 5.4, and did it reduce abandoned sign-ins and password resets?

## Method

* All app sessions that needed a sign-in, weekly, from the week of the 5.4 release.
* Adoption is the share of those sessions that used biometric sign-in instead of a password.
* Abandoned sign-in: the sign-in screen was shown and the session ended without a sign-in. Password resets come from `identity-svc`, app origin only.

## Results

@@picture:rn-067-adoption@@

@@table:rn-067-adoption@@

@@csv:rn-067-adoption@@

| Measure | Four weeks before 5.4 | Weeks 9 to 12 after | Change |
| -- | -- | -- | -- |
| Abandoned sign-ins at checkout | 18.0 % | 11.2 % | −6.8 points |
| Password resets from the app, per week | 2,170 | 1,240 | −43 % |
| Median time to sign in | 21 s | 3 s | −86 % |

## Findings

* Adoption rose quickly and is flattening: 69 % of signed-in sessions on iOS and 57 % on Android by week 12.
* Android trails because 14 % of Android users have no biometric hardware that meets the strong class the app requires.
* Abandoned sign-ins at checkout fell from 18.0 % to 11.2 %. Password resets from the app fell by 43 %.
* 9 % of buyers declined enrolment when it was offered. Offering it once more after 60 days, as [RFC-069](@RFC-069) proposes, would reach about 600,000 buyers.

## Recommendation

Keep biometric sign-in as the default for enrolled devices, offer enrolment once more after 60 days, and start the passkeys RFC for buyers without biometric hardware.

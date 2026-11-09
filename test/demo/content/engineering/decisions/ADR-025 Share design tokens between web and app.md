| Status | Accepted |
| -- | -- |
| Date | 2025-11-16 |
| Authors | DemoLaura |
| Reviewers | DemoNina, DemoPeggy |

## Context

With a native app ([ADR-024](@ADR-024)) next to the web shop, colours, spacing and type sizes are defined three times: in CSS, in Compose and in SwiftUI. An audit in November found 47 slightly different greys and 9 primary button colours across the three. A brand colour change would touch hundreds of files.

## Decision

Colours, type, spacing, radii and motion are **design tokens in one JSON file**, transformed at build time into CSS variables, Kotlin and Swift.

* Tokens follow the Design Tokens Community Group format; Style Dictionary generates platform files.
* Two layers: base tokens (raw values) and semantic tokens (`color.action.primary`), which screens use. Screens never use base tokens.
* Light and dark themes are two sets of semantic tokens over the same base tokens.
* A change to tokens is a pull request reviewed by design and by one engineer per platform.

```json
{
  "color": {
    "blue": { "600": { "$value": "#2a78d6", "$type": "color" } },
    "action": {
      "primary": { "$value": "{color.blue.600}", "$type": "color" }
    }
  },
  "space": { "md": { "$value": "16px", "$type": "dimension" } }
}
```

## Options considered

| Option | Sources of truth | Brand change effort | Tooling | Verdict |
| -- | -- | -- | -- | -- |
| **One tokens file, generated per platform** | **1** | **one pull request** | **open source** | **Chosen** |
| Tokens in the design tool, exported by hand | 1 plus copies | export and three pull requests | design tool plugin | Copies drift |
| Each platform keeps its own values (today) | 3 | hundreds of files | none | The problem we have |

## Consequences

* Web and app look the same, also in dark mode.
* Platform teams cannot tweak a colour locally; they propose a token.

## Follow-up

- [X] Tokens file with the current palette, cleaned up to 12 greys
- [X] Generated CSS, Kotlin and Swift in CI
- [ ] Remove hard-coded colours from the web shop

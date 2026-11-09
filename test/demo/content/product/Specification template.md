| Status | Stable |
| -- | -- |
| Version | 1.1 |
| Updated | 2025-06-02 |
| Owner | DemoErin |
| Applies to | Every document in a `specs/` folder of the Product and Engineering teams |

## Purpose

A specification describes what a part of DemoMart does and what it accepts and returns, precisely enough to build against without asking. It is not a proposal: proposals are RFCs. A specification changes by new versions, recorded in its version history.

## Status table

Every specification starts with this table:

| Row | Content |
| -- | -- |
| Status | `Draft`, `Stable` or `Deprecated` |
| Version | `major.minor`; a major change breaks callers |
| Updated | Date of the latest version |
| Owner | The placeholder name of the owner, for example DemoErin |
| Applies to | The services, apps or pages bound by it |

## Sections

1. **Overview**: what it is and why, in one paragraph.
2. **The model**: field tables with type, whether required, and a description.
3. **An example** in JSON, Protobuf or YAML with realistic values.
4. **Behaviour**: a sequence or state diagram in Mermaid when there is more than one step.
5. **Errors and limits** as tables.
6. **Version history**.

## Conventions

- [X] Money is an integer amount in minor units with a currency ([ADR-020](@ADR-020))
- [X] Times are UTC in RFC 3339 format
- [X] Ids have a short type prefix, such as `ord_`, `pi_`, `crt_`
- [X] Field names are `snake_case`
- [ ] Every new specification links the RFC that introduced it

## Example field table

| Field | Type | Required | Description |
| -- | -- | -- | -- |
| `id` | string | yes | `ord_` and 12 characters |
| `total` | money | yes | Order total |
| `note` | string | no | Free text, up to 500 characters |

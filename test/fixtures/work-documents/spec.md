# Export feature specification

## Goal

Users can export a report as CSV from the reports page.

## Requirements

| ID | Requirement | Priority |
| -- | -- | -- |
| R1 | Export the visible columns | High |
| R2 | Keep the current filters | High |
| R3 | Name the file after the report | Medium |

## Out of scope

* Scheduled exports
* Other file formats

## Example

```csv
date,region,total
2024-01-01,north,120
```

Ref kx-34773676
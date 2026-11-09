| Owner | DemoAlice |
| -- | -- |
| Updated | 2025-01-08 |
| Decided in | [ADR-001 Record architecture decisions as Markdown files](@ADR-001) |

Copy this structure for a new architecture decision record. One decision per record; the title says the decision as an imperative ("Use Kafka for domain events"), not the topic ("Messaging").

## Status table

| Field | Required | Example |
| -- | -- | -- |
| Status | yes | Proposed, Accepted, Implemented or Superseded |
| Date | yes | The day the decision was accepted |
| Authors | yes | Who wrote the record |
| Reviewers | yes | Who agreed, at least two |
| Supersedes | when it replaces a record | A link to the older ADR |
| Superseded by | when replaced | A link to the newer ADR |
| Plan or Evidence | when they exist | The RFC or research note behind the decision |

## Sections

### Context

What forces the decision now. Facts with numbers: incidents, costs, measurements. Keep opinions for the options.

### Decision

The decision in one sentence, then the rules that make it concrete: names, limits, defaults, what is out of scope. A short code or configuration sample helps more than a paragraph.

### Options considered

A table with one row per option, including "do nothing", and the criteria that decided between them. Each rejected option gets a reason in its last column.

### Consequences

What gets better, what gets worse, and what new work or cost the decision creates.

### Follow-up

A task list of what must happen for the decision to be implemented:

- [ ] First step
- [ ] Second step

## Good habits

* Write it in under an hour; a record that takes a week is an RFC.
* Never edit an accepted record to say something else. Write a new one that supersedes it, and add "Superseded by" to the old one.
* Link the research and RFCs the decision rests on.

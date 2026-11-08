Diagram of the state kind.

```mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Review
  Review --> Published
  Published --> [*]
```

Ref kx-7153ef2a
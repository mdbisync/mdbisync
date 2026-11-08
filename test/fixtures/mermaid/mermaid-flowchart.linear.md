Diagram of the flowchart kind.

```mermaid
flowchart TD
  Start --> Check{Ready?}
  Check -- yes --> Ship
  Check -- no --> Fix --> Check
```

Ref kx-854e6c3d
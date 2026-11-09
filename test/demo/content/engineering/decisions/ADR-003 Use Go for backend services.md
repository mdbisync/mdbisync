| Status | Accepted |
| -- | -- |
| Date | 2025-01-27 |
| Authors | DemoDave |
| Reviewers | DemoAlice, DemoGrace |

## Context

DemoMart's backend is written in four languages: Go (5 services), Node.js (4), Python (2) and Kotlin (1). Each language has its own libraries for logging, tracing, configuration and database access, and each was set up differently. A fix to the tracing setup had to be made four times in November 2024. Engineers rarely move between services because the stacks differ.

## Decision

New backend services are written in **Go**. Existing services move to Go when they need a major rewrite, not before.

* One shared module, `demomart/kit`, provides logging ([SPEC-004](@SPEC-004)), tracing ([SPEC-005](@SPEC-005)), metrics, configuration and health checks ([SPEC-002](@SPEC-002)).
* The service template of [RFC-002](@RFC-002) starts every new service with that module.
* Node.js stays for the web shop's server rendering ([ADR-023](@ADR-023)); Python stays for data notebooks.

```go
func main() {
    svc := kit.New("catalog-svc")
    defer svc.Shutdown()

    db := svc.Postgres("CATALOG_DB")
    srv := catalog.NewServer(db, svc.Logger())
    svc.ServeGRPC(srv.Register)
    svc.Run()
}
```

## Options considered

| Option | Median p99 latency in our services | Memory per replica | Cold start | Engineers fluent | Verdict |
| -- | -- | -- | -- | -- | -- |
| **Go** | **18 ms** | **60 MB** | **41 ms** | **14 of 22** | **Chosen** |
| Kotlin on the JVM | 22 ms | 380 MB | 1,240 ms | 5 of 22 | Memory and start time |
| Node.js | 31 ms | 140 MB | 182 ms | 16 of 22 | Weaker typing for domain code |
| Keep four languages | varies | varies | varies | varies | The problem we have |

Start times are from [RN-002](@RN-002).

## Consequences

* Shared tooling has one implementation, maintained by the platform group.
* Engineers who know only Node.js or Kotlin need time to learn Go; we budget two weeks per person.
* Four services stay in other languages for now and get the shared conventions by hand.

## Follow-up

- [X] Publish `demomart/kit` 1.0
- [X] Service template in Go
- [ ] Rewrite `notify-svc` (Node.js) in Go during its redesign ([ADR-039](@ADR-039))

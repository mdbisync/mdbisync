# Scenario data contract

Each `L*.yaml` file is a YAML 1.2 document written in its JSON subset. Parse
it with `JSON.parse`; no YAML library is needed. Keep this subset when editing.
The two checks use Node 24 and its standard library:

```sh
node --test test/scenario-schema.test.ts test/scenario-coverage.test.ts
```

These checks validate the specification data; they do not claim that the sync
engine passes the scenarios. An execution harness supplies the adapters below.
Missing adapters, fixtures, observations or golden forms must fail explicitly
(or report an unavailable environment with a reason), never silently pass.

## Setup and execution

`version` selects this contract. `id` must equal the filename without `.yaml`.
`slice` selects `mini`, `bank`, `mid` or `full`. `mode` routes engine invocations
to a local process or real Actions workflow; `ui` combines browser steps with
engine invocations. Editor roles are neutral fixture identities, resolved by
the execution environment, never embedded credentials or account names.

`setup.state` selects the starting baseline:

- `offline`: scratch files and repositories; no remote documents or sync refs.
- `empty`: mapped projects exist, with no documents and no state refs.
- `no-state`: configured repository with no sync state; test refusal to run.
- `converged`: complete initial sync, with matching tracked files and documents.
- `linear-seeded`: existing documents for reverse initial sync, no initial refs.
- `conflicted`: a converged fixture followed by an unresolved conflict, with the
  original icon, color and body saved as `beforeConflict` observations.

`fixtures` names required semantic fixture groups within the slice. The harness
resolves these groups, including custom images, comments, archived documents,
security hooks and conflict markers; it must reject unknown fixture groups.
Slice membership alone must not substitute for a requested fixture group.
`teamZoneLock` requires serialization for any team zones used by that setup.
Every setup must isolate branches, refs and documents, enforce the shared API
budget and clean up in a finalizer, including after faults or cancellation.
Fixture text written to remote documents must be ordinary work content.

Steps execute in order. `kind`, `action` and `args` form the adapter call:

| Kind | Adapter responsibility |
| --- | --- |
| `git` | Apply and commit the stated file, annotation, branch, ref or PR operation; push normally. Run format hooks unless `bypassHook` is true. |
| `linear` | Apply the stated document operation using the selected editor role. |
| `run` | Invoke the named command or orchestration operation and collect observations. |
| `fault` | Configure a proxy response, engine checkpoint, setup failure or check result. `clear` removes injected faults; `resume` releases a paused engine. |
| `kill` | Terminate the engine at the named checkpoint; wait for actual termination. |
| `merge` | Merge the initial pull request as the specified person. |
| `ui` | Verify the signed-in editor, perform the stated browser action, and collect DOM evidence. |

`run.args.wait: false` starts an engine asynchronously; a checkpoint is reached
before the following step executes. The harness joins that invocation after
`resume` or `kill`. Ordinary invocations wait for completion. `settle` and
`resume-until-complete` run bounded recovery cycles until quiescence, retaining
per-invocation evidence. `parallel` bypasses workflow serialization on purpose;
`workflow-parallel` tests the actual concurrency group. A timeout is a failure,
not convergence. `probe`, `lint`, `fix`, `pre-commit`, `scan-canaries`, `cleanup`,
`burst`, `soak` and `token-lifecycle` invoke their respective test adapters.

An argument named `variants` or `orderings` expands into independent subcases,
each with a fresh copy of setup and the complete step sequence and assertions.
All subcases must pass. `before` is captured after setup, before the first step;
`edited`, `input`, `fixtures`, `golden`, `corpus`, `expected`, `oracle` and
`resolved` refer to independent fixture or oracle observations, never values
computed from the actual result being checked. `runs.0` is the first explicit
engine invocation, `runs.1` the second, and `runs.last` the final invocation.
Internal recovery cycles retain their own evidence. Setup invocations and
invariant idempotency probes do not change those indices.

Samples must cover every requested construct, not just select the first files.
UI steps verify the editor and screen availability before input, collect DOM
assertions and screenshots, and describe what the screenshots show. Race
measurements record observed loss and window duration even when nonzero.

## Checks

Each scenario declares all nine invariants. `required: false` needs a concrete
applicability reason, for example an offline lint check with no synchronized
state. Evaluate the required invariants after the final step, before cleanup;
I6 uses an extra read-only-observation probe of an ordinary no-change run.
Transient assertions such as `runs.0.writes.total` inspect that invocation,
including failed runs; later recovery must not erase that evidence.

| ID | Required observation |
| --- | --- |
| I1 | Eligible synchronized bodies converge byte for byte, stripping front matter and reversing asset link mapping. |
| I2 | Every generated edit survives on both sides or inside conflict versions. |
| I3 | Only explicit scenario pushes and sync PR merge commits move the tracked branch. |
| I4 | State refs and sync branch move forward; a refused atomic lease changes nothing. |
| I5 | No canary in logs, summaries, PR text or document comments. |
| I6 | An additional unchanged run writes no documents, commits or PRs. |
| I7 | Each synchronized path has one existing document ID with its expected mapped title. |
| I8 | No duplicate documents in the isolated project and team-zone scope. |
| I9 | Requests are at most 1.5 per written document plus 5 per invocation. |

Assertions address dot-separated observation paths, including array indexes.
`equal` performs deep equality against the literal `expected`; `same-as`
resolves `expected` as another observation path and compares deeply.
`contains-all` tests array membership by deep equality. `at-most` and `at-least`
compare finite numbers. Unresolved paths, wrong operand types or unavailable
measurements are errors, never equal to missing values. Count assertions over
collections such as `uploads.perHash` apply to every member, not an average.
Checks such as `documents.allEditsPreserved` must compare unique seeded edit
markers against both sides rather than assume success from a clean exit.

`proposedRule` records a testable proposed behavior. The concrete checks remain
binding until the behavior and its specification are deliberately revised.
The unsafe-title proposal preserves the original title, percent-encodes unsafe
path segments and disambiguates collisions using the document ID. It must be
implemented as a reversible mapping; plain title normalization is insufficient.

## Catalog maintenance

`catalog.json` contains IDs only, extracted in source order from scenario
headings of the form `- **L1-01 Title.**`. It is independent of the spec directory,
so removing a spec cannot make coverage pass by regenerating IDs from filenames.
Given a Markdown scenario catalog as `scenario-catalog.md`, regenerate with:

```sh
node --input-type=module - scenario-catalog.md <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const source = readFileSync(process.argv[2], 'utf8');
const ids = [...source.matchAll(/^- \*\*(L(?:[0-6]|1R)-\d{2}) /gm)].map(m => m[1]);
if (!ids.length || new Set(ids).size !== ids.length) throw Error('Invalid catalog');
writeFileSync('test/scenarios/catalog.json', JSON.stringify(ids, null, 2) + '\n');
JS
```

To verify the committed catalog directly against that source as well:

```sh
SCENARIO_CATALOG_SOURCE=scenario-catalog.md node --test test/scenario-coverage.test.ts
```

Commit only the IDs, never the source catalog itself. Schema validation rejects
unknown fields, actions, kinds, modes, slices, missing invariants, empty steps
or assertions, and the absence of any required proposed rule. Coverage validation
rejects missing, extra, duplicate and misnamed specs and duplicate catalog IDs.

---
name: verify-formal-tasks
description: Check the task lifecycle invariants and the cycle and readiness proofs. Use when changing dependencies, ranking, explicit reopening, imports, event projection, rebuild, or any file in spec/ or proofs/.
---

# Formal verification for tasks

## Promises and limits

| Rule | Promise | Code that enforces it |
|---|---|---|
| `NoCycle` | Stored tasks never depend on themselves through a chain. | `addDep` and `checkGraph` in `src/domain/graph.ts`; `addTask`, `changeDependency` and `importTasks` in `src/db/tasks.ts` check before appending changes. |
| `NextOnlyUnblocked` | Next work is open and every prerequisite is done. | `rank` in `src/domain/graph.ts` uses the complete task status map, then the CLI applies selection filters. |
| `DoneIsTerminalUnlessReopened` | A finished task changes status only through an explicit reopen to todo. | `parseStatusChange` in `src/domain/lifecycle.ts`; `changeStatus` and `importTasks` enforce it, and `parseUpdate` excludes status patches. |
| `ReplayEqualsState` | Replaying events gives the stored tasks and dependencies. | `appendEvent` records complete task snapshots; the kit `writeCommand` wraps writes in one transaction; `rebuild` folds the snapshots and replaces projections atomically. |
| `addDep_ok_iff` | The reachability check accepts exactly the edge additions that preserve acyclicity. | `proofs/CycleCheck.lean` proves the definition; the 10,000-graph TypeScript property test compares `addDep` with an independent cycle evaluator. |
| `next_sound` | Every selected task has its prerequisites done. | `proofs/CycleCheck.lean` proves the selection definition; domain and CLI tests exercise real ranking and cross-list prerequisites. |

The TLA+ model has four tasks and checks every reachable state under that bound. It abstracts task content, timestamps, the full SQL schema and scheduling. Lean proves graph properties without a size bound. Neither tool proves that all TypeScript or SQLite behavior matches the model; contract, property, concurrency and end-to-end tests bridge those interfaces.

A model action corresponds to one database transaction. `withReadSnapshot` provides one consistent read snapshot while another process writes. The SQL schema rejects updates and deletes to `events`. These database details are covered by integration tests rather than by the abstract lifecycle model.

## Run

Install the pinned tools through mise and elan as described in README.md. From the repository root:

```sh
npm run tlc && npm run lean
```

The kit TLC runner verifies its downloaded jar checksum, runs the primary model, and requires each deliberately broken variant to fail its named invariant from `spec/broken/EXPECTED.json`. A positive row includes the explored state count. A broken variant is a successful check only when it violates its expected rule. `npm run lean` requests the optional Mathlib cache and then requires `lake build` to succeed. A missing cache never skips proof checking.

The Lean proof uses a local membership instance that reads a finite set's underlying multiset directly. This is definitionally the same membership relation and preserves the constructive axiom bounds when newer library set-coercion instances carry an additional classical assumption. The theorem statements and graph definitions retain their meaning.

`proofs/CycleCheck.lean` contains exact axiom guards. An unfinished proof introduces `sorryAx`, which makes the build fail. Do not loosen an invariant, a guard, or an expected failure to make a check pass.

## Correspondence record

The inherited formal baseline is commit `2a5bf988e9c126c83811af1ab1828a1460a9fbb3`. The implementation correspondence is the table above. When committing a changed implementation, record its reviewed commit here after verifying that the listed functions still enforce the rules. Use `git log` for the covered paths to find changes since the recorded review; a successful checker run does not establish correspondence by itself.

Covered paths are `spec/`, `proofs/`, `src/domain/types.ts`, `src/domain/graph.ts`, `src/domain/lifecycle.ts`, `src/domain/requests.ts`, `src/db/tasks.ts`, `src/cli/main.ts`, `migrations/` and their domain/CLI tests.

## Read a result

Use the public pstack `/statechart` skill when available to read each TLC result. A violated invariant is a shortest sequence of actions that reaches a bad state. For a passing bounded model, the same skill can draw the allowed state transitions. The raw output is sufficient when that optional tool is absent.

Find `Error: Invariant <name> is violated.` and read the numbered states below it. Each header names the action that led to that state. Compare the variables with the prior state, then translate each action into one CLI command:

- `Add`, `AddDep` and `RemoveDep` mean `add`, `dep add` and `dep rm`.
- `SetStatus` and `Reopen` mean a status change and `status` with `reopen:true`.
- `AskNext` means `next`; `offered` is the proposed work.
- `deps` contains task/prerequisite pairs. `replayed` is the state reconstructed from history.

The broken cycle variant allows a dependency loop. The broken next variant offers a task before its prerequisite is done. The broken status variant overwrites a done state. The broken removal variant changes an edge without logging it. CLI regression tests replay the relevant sequences against the actual binary.

The TypeScript cycle property was also checked against a scratch copy with the `addDep` cycle guard removed. It failed on a one-node self-loop; the unchanged implementation passed all 10,000 generated graphs afterward. Repeat this negative check in an isolated scratch copy when changing the proof-to-code bridge, preserving the failed output and deleting only the scratch sources.

For a failure, preserve the output and replay the trace against the implementation. If the code cannot take a modeled step, identify the guard or assumption that differs before changing the model. If the code takes the steps and violates the promise, fix the implementation rather than weakening the promise. A deliberate model change needs a corresponding implementation change and a broken variant that demonstrates detection.

For Lean, the error names the failing theorem or axiom guard. A toolchain upgrade may need proof syntax updates, but theorem statements, definitions and guarded assumptions must retain their meaning. Rerun both formal checks and the implementation tests after such an upgrade.

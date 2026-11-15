# Formal checks for the tasks module

Two tools check the rules that the task tracker must never break. Both run before any tracker code exists, so the code that comes next is written against rules that are already checked.

Run everything with:

```sh
bash spec/check.sh
(cd proofs && lake exe cache get && lake build)
```

## `TaskLifecycle.tla`: the model

A small model of the tracker with four tasks. A bot can add a task, add or remove a dependency, set a status, reopen a finished task, and ask what to work on next. The model checker (TLC) tries every order of those steps and checks four rules in every state it can reach. There is no limit on how many steps happen: the run covers every combination of statuses and dependencies that four tasks can get into (about 690,000 distinct states, about two minutes).

| Rule | In plain words | Harm if it breaks |
|---|---|---|
| `NoCycle` | No task ever ends up waiting on itself, directly or through other tasks. | Tasks in the loop can never start, and the critical path has no answer. |
| `NextOnlyUnblocked` | The answer to "what next" never includes a finished or canceled task, or a task with a prerequisite that is not done. | A bot starts work that cannot be finished yet. |
| `DoneIsTerminalUnlessReopened` | A finished task changes status only through an explicit reopen. | Finished work silently goes back to open, or history can no longer say why. |
| `ReplayEqualsState` | Replaying the event history gives exactly the stored tasks and dependencies. | `rebuild` produces different data than the bots have been reading. |

`TypeOK` is also checked: values stay in their allowed sets, and a dependency only joins tasks that exist.

How the model stands for the real thing:

- `status` and `deps` are the `tasks` and `deps` tables. A pair `<<a, b>>` in `deps` means task `a` depends on task `b`.
- The event history is held as `replayed` (what replaying every event so far gives), `lastEvent` (the newest event) and `lastTaskWasDone` (whether that event's task was done just before it). Each write step updates the tables with its own rule and appends an event; the two must agree.
- `offered` is the answer to the latest "what next" question. Any write clears it, because the answer is only promised for the data it was computed from.
- The step named `AskNext` is the `next` command (the name `Next` is taken by the model's own step relation).
- `Reaches` is the reachability check that `addDep` uses: adding "a depends on b" is refused when `a = b` or `b` already leads to `a`.

Each write step is one transaction in the code: append the event and update the tables together.

## `broken/`: proof that each rule can fail

Each file in `spec/broken/` is the model with one guard removed. `check.sh` requires each to fail on the rule named in `broken/EXPECTED.json`, and to differ from the model by only a few lines.

| Variant | What is removed | Rule that must fail |
|---|---|---|
| `AddDepNoCycleCheck` | The reachability check when adding a dependency | `NoCycle` |
| `NextIgnoresDeps` | The prerequisite check in "what next" | `NextOnlyUnblocked` |
| `SetStatusOverwritesDone` | The guard that stops a plain status change on a finished task | `DoneIsTerminalUnlessReopened` |
| `DepRemovedNotLogged` | The event for removing a dependency | `ReplayEqualsState` |

## `proofs/CycleCheck.lean`: the proof

The model covers four tasks. The Lean proof covers every size. A graph is a finite set of pairs over `Fin n` (the numbers below `n`); `(a, b)` in the graph means `a` depends on `b`.

- `addDep_ok_iff`: for a graph with no cycle, the check `¬ reachable g b a ∧ a ≠ b` passes exactly when the graph still has no cycle after adding `(a, b)`. The check never refuses a safe dependency and never accepts an unsafe one.
- `addDep_ok_iff_not_reflReachable`: the same result for a search that starts at `b` and counts `b` itself as reached, which is how a depth-first search is usually written.
- `acyclic_erase`, `acyclic_empty`: removing a dependency, or starting empty, cannot create a cycle.
- `next_sound` and `mem_next_iff`: a task returned by `next` has every prerequisite done, and `next` returns exactly the open tasks for which that holds.
- `next_nonempty_of_acyclic`: with no cycle, if any task is still open then `next` returns at least one task (when "open" means "not done").

The file also states which axioms each theorem uses. The build fails if a theorem starts to depend on anything else, including an unfinished proof.

## Which code this constrains

| Code (to be written in `src/`) | Constrained by |
|---|---|
| `addDep` in `src/domain` and the cycle check inside `import` | `NoCycle`, `addDep_ok_iff` |
| `rank` in `src/domain` and the `next` command | `NextOnlyUnblocked`, `next_sound` |
| the `status` command and how a reopen is recorded | `DoneIsTerminalUnlessReopened`; `StatusChange` in `src/domain/types.ts` |
| every write in `src/db` (append event, apply to tables) and `rebuild` | `ReplayEqualsState` |

## What is not covered

- The model checks the design, not the TypeScript. Tests must tie the code to it: the property test that compares the TypeScript cycle check with a brute-force evaluator of the Lean definition, and the property test that `rebuild` equals the tables.
- Only `created`, `status`, `dep_added` and `dep_removed` events are modeled. `updated` does not touch status or dependencies. `imported` is a batch of the modeled steps and must run the same cycle check before it commits.
- Ranking order, critical path, due dates, lists, labels, process analyses and scheduling are not modeled.
- A canceled prerequisite counts as not done, as in the ranking rule "all deps done". A canceled task can be set back to an open status without a reopen; only `done` needs one.
- Crashes in the middle of a write are not modeled; the model assumes each write is one transaction.

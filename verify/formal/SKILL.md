---
name: verify-formal-tasks
description: "Check the task tracker's four lifecycle rules and its cycle check against the TLA+ model and the Lean proof. Use when a change touches adding or removing dependencies, status changes or reopening, the next command or ranking, event writes, rebuild or import, or any file in spec/ or proofs/."
---

# Formal verification for the tasks module

## What is verified

| Rule | In plain words | Harm if it breaks |
|---|---|---|
| `NoCycle` | No task ever waits on itself, directly or through other tasks. | Tasks in the loop can never start. |
| `NextOnlyUnblocked` | "What next" never returns a closed task or one with a prerequisite that is not done. | A bot starts work that cannot be finished yet. |
| `DoneIsTerminalUnlessReopened` | A finished task changes status only through an explicit reopen. | Finished work silently reopens. |
| `ReplayEqualsState` | Replaying the event history gives exactly the stored tables. | `rebuild` produces different data than the bots read. |
| `addDep_ok_iff` (Lean) | The check "b does not lead to a, and a is not b" accepts exactly the dependencies that keep the graph free of cycles, at every size. | A safe dependency is refused, or a cycle is stored. |
| `next_sound` (Lean) | Every task `next` returns has all its prerequisites done. | Same as `NextOnlyUnblocked`. |

Tools: TLA+ with the TLC model checker for the order-of-steps rules, because the question is whether any order of commands can reach a bad state. Lean 4 with Mathlib for the cycle check, because that must hold for graphs of every size and a four-task model cannot show that.

Bounds: the model has four tasks, with no limit on the number of steps. The Lean proof has no bound. `spec/README.md` lists what is left out.

## The one command

From the repo root:

```sh
bash spec/check.sh && (cd proofs && (lake exe cache get || true) && lake build)
```

`spec/check.sh` installs Java 21 through mise, downloads `tla2tools.jar` 1.8.0 into `~/.cache/ambitious/` and refuses it unless its SHA-256 matches the pinned value. It runs the model (must pass; about two minutes) and every variant in `spec/broken/` (each must fail on the rule named in `spec/broken/EXPECTED.json`). It ends with a line that starts `OK:`. `lake exe cache get` downloads prebuilt Mathlib and only saves time, so its failure is ignored. `lake build` needs `elan`; it ends with `Build completed successfully`, and fails if any theorem depends on an axiom outside the list written next to it in `proofs/CycleCheck.lean`, which includes an unfinished proof.

## Covered code

Last confirmed in step with the code at commit `a354f6158b59ae93287e7b1bca8aa420438b2ab7`. At that commit the tracker code does not exist yet; the model describes the design in `spec/README.md` and the types in `src/domain/types.ts`.

| Model or proof part | Code it describes |
|---|---|
| `AddDep`, `Reaches`; `addDep_ok`, `reachable` in Lean | `addDep` in `src/domain`, and the cycle check `import` runs before it commits |
| `RemoveDep` | the `dep rm` command |
| `SetStatus`, `Reopen` | the `status` command; `StatusChange` in `src/domain/types.ts` |
| `AskNext`, `Ready`; `next`, `unblocked` in Lean | `rank` in `src/domain` and the `next` command |
| `AppendEvent`, `Apply`, `replayed` | the write transaction in `src/db` (append event, apply to `tasks` and `deps`) and `rebuild` |
| `status`, `deps` | the `tasks.status` column and the `deps` table |

Run `git log a354f6158b59ae93287e7b1bca8aa420438b2ab7..HEAD -- src/domain src/db spec proofs`. If it lists commits, read them against the table before you trust a pass. Move the commit above forward only after you have confirmed that every row still describes the code at the new commit.

One step in the model is one transaction in the code. If a write is ever split across transactions, the model no longer describes it; model the split before relying on a pass.

## Reading a result

When a check fails, `spec/check.sh` prints TLC's full output. Find the line `Error: Invariant <Rule> is violated.`; the rule it names is the one that broke. Below it TLC prints the shortest path to the bad state as numbered states (shortened here):

```
Error: Invariant NextOnlyUnblocked is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\ offered = {}
/\ deps = {}
/\ status = (t1 :> "absent" @@ t2 :> "absent" @@ t3 :> "absent" @@ t4 :> "absent")
...

State 2: <Add(t1) line 56, col 3 to line 60, col 19 of module NextIgnoresDeps>
/\ offered = {}
/\ deps = {}
/\ status = (t1 :> "todo" @@ t2 :> "absent" @@ t3 :> "absent" @@ t4 :> "absent")
...
```

Each `State N` header names the step that led to that state, and the lines under it give the value of every variable after the step. Read down the list and compare each state with the one before it: the variables that changed are what the step did. The last state is the one that breaks the rule. Write the path down as one command per line before deciding anything.

To run one model by hand and keep the output, use the jar the script downloaded, from the repo root:

```sh
(cd spec/broken && mise exec -- java -cp ~/.cache/ambitious/tla2tools-1.8.0.jar tlc2.TLC -workers 1 -metadir "$(mktemp -d)" -noGenerateSpecTE -config NextIgnoresDeps.cfg NextIgnoresDeps.tla)
```

To tell the path in the tracker's words:

- `Add`, `AddDep`, `RemoveDep`, `SetStatus`, `Reopen` are the commands `add`, `dep add`, `dep rm`, `status` and a reopen. `AskNext` is `next`.
- `status` is each task's stored status; `absent` means not created yet.
- `deps` holds pairs: `<<t2, t1>>` means t2 depends on t1.
- `offered` is what the last `next` returned.
- `replayed` is what the event history says the tables should hold. If it differs from `status` and `deps`, a write and its event disagree.
- `lastEvent` is the newest event; `lastTaskWasDone` says whether its task was done just before.

Example, from `spec/broken/NextIgnoresDeps`: add t1, add t2, make t2 depend on t1, ask `next`; the answer includes t2 although t1 is still todo.

When the model passes, the `PASS` line gives the number of distinct states TLC checked. `spec/check.sh` fails if that number is too small for the model to be exploring anything.

## Real bug or modeling error

1. Replay the path against the real code, one command per step, as a test. If the code does the same, it is a real bug: report it with the path. Do not weaken the rule, and do not change product code unless asked.
2. If the code cannot take one of the steps, the model allows something the code forbids. Find the guard in the code, add it to the model, and say so in the pull request.
3. If a broken variant stops failing, or fails on a different rule, the model changed so that the rule can no longer catch that break. Treat that as a failure of the model.

For Lean, a failed build names the line. A message about `#guard_msgs` means a theorem's axioms changed; `sorryAx` in the list means a proof is unfinished.

## Changing the model on purpose

- Change `spec/TaskLifecycle.tla` first, then make the same change in each file in `spec/broken/`, keeping only its one removed guard. `check.sh` fails if a variant drifts more than a few lines from the model.
- A new rule needs a new broken variant that fails on it, a line in `spec/broken/EXPECTED.json`, and a row in `spec/README.md`.
- If the cycle check in the code changes shape, change `addDep_ok` in `proofs/CycleCheck.lean` to match and prove `addDep_ok_iff` again. The property test in TypeScript must compare against the same definition.
- Run the one command, then update the commit in "Covered code".

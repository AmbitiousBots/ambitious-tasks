---
name: verify-tasks
description: Verify the Ambitious Tasks module through its built JSON CLI against fresh databases. Use after implementation changes, before a release, and when checking a reported task, import, process or schedule behavior.
---

# Verify Ambitious Tasks

The caller's interface is the built CLI. This skill drives that binary, checks response envelopes and stored results, and leaves logs. It does not require a server, account, key or hosted service.

## Launch and doctor

Install mise and elan as described in README.md, then run:

```sh
mise trust && mise install
npm ci
npm run build
verify/run --doctor
```

The doctor checks Node, dependencies and feature metadata. A missing prerequisite is a failure to resolve, not permission to remove its check.

## Drive the feature map

```sh
verify/run
verify/run --list
verify/run --only import --only next --only graph
```

`verify/features.json` is the maintained feature map. It covers command discovery, startup, every write and read command, import and replay, read-only process and schedule analysis, the shared contract, standalone documentation and the lifecycle model. Every command feature invokes `scripts/verify-feature.mjs`, which launches the real binary and asserts the observable result. The map is executable; `--list` shows the exact command for each feature.

Each feature receives its own empty `AMBITIOUS_HOME`. Its fixture creation is part of the check. Import/next/graph checks use `test/fixtures/work-plan.json`; process checks create a timeline with known two-day waits and cycle times; the counts check places one task exactly seven days before the command time and one a millisecond inside that window; schedule checks provide a bounded roster and independently check the suggested result. No default data directory is used.

For the full release gate, also run:

```sh
npm run release:check
```

That includes type and import checks, the CLI tests, the 10,000-graph cycle property test, generated replay histories, migrations, TLC and Lean. A green feature table alone is not a substitute for these gates.

## Evidence and cleanup

`verify/run` prints one pass/fail row for every selected feature and exits nonzero for a failure. It keeps the full command output in an evidence directory and prints that location after the table. It removes every temporary database it created, including after failures, while preserving logs. Do not remove evidence before the review is complete.

The CLI can be driven manually by setting `AMBITIOUS_HOME` to a new temporary directory, running `selfcheck`, then passing a command JSON on stdin. Fix `--now` and `--seed` to reproduce output. Read command inputs and output assumptions in README.md before changing a check.

## Maintaining coverage

Add or update a feature entry whenever a command's visible behavior changes. Add the assertions at the real CLI boundary. A check must fail when the promised result breaks and keep passing when only private implementation structure changes. Use the public pstack `/maintain-verification-skill` workflow when available to review map drift.

Real Grok Bot installation, persistence after a computer update, and changing another bot's instructions are external checks. This local skill does not claim they ran.

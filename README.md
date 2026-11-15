# ambitious-tasks

Ambitious Tasks is a persistent command-line task tracker for bots. It stores tasks, prerequisites and append-only history in SQLite. It suggests available work, reports the critical path, measures process times, simulates finish dates and checks proposed schedules. Every command reads JSON and returns one JSON envelope. There is no user interface, document rendering, network access or AI key requirement.

Part of [Ambitious](https://ambitiousbots.com). The shared [module contract](https://github.com/AmbitiousBots/ambitious-kit/blob/kit-v0.1.1/MODULE_CONTRACT.md) defines the envelope, installation, database and runtime rules.

## Run

The release contains `ambitious-tasks-0.1.2.mjs` and `SHA256SUMS`. Verify the checksum before running the file with Node 24. The binary includes its dependencies and migrations; it needs no npm install or other repository files.

```sh
shasum -a 256 -c SHA256SUMS
export AMBITIOUS_HOME="$(mktemp -d)"
node ambitious-tasks-0.1.2.mjs selfcheck
printf '%s\n' '{"id":"draft","title":"Prepare the draft","estimate_days":1,"idem_key":"create-draft"}' | node ambitious-tasks-0.1.2.mjs add
node ambitious-tasks-0.1.2.mjs next --now 2026-01-01T00:00:00Z --seed 7
```

Choose a persistent `AMBITIOUS_HOME` for real work; the temporary directory above is for trying the commands. The default is `/workspace/ambitious`, the module storage directory on a Grok Bot computer. The database lives at `$AMBITIOUS_HOME/tasks/tasks.sqlite`; `--db` overrides that file. Modules refuse `/home/box/agent-data`, the bot's private state directory, including paths that reach it through symbolic links. These documented runtime paths are listed in `.standalone.json`.

The kit's [installer](https://github.com/AmbitiousBots/ambitious-kit#start-a-module-on-the-kit) verifies release checksums and installs an exact version under `$AMBITIOUS_HOME/bin`. Running it again for an intact installed version changes nothing. Run `selfcheck` at every routine start, including after a computer update.

## JSON interface

```text
ambitious-tasks <command> [--in input.json] [--db tasks.sqlite] [--now ISO8601] [--seed integer] [--json]
```

Pass one JSON object on stdin or with `--in`, never both. `--json` is accepted and changes nothing because output is always JSON. Optional filter commands accept omitted input as `{}`. Required fields are rejected before opening the database.

Every response is one line with `{ ok, schemaVersion, module, command, data, errors, meta }`. `meta` contains the UTC `now`, integer `seed` and binary `version`. Successful commands exit 0; caller errors exit 1; database and internal failures exit 2. Each error has `code`, a plain-language `message` and an actionable `hint`. The same binary, database state, input, time and seed produce identical stdout bytes.

| Command | Access | Input | Result in `data` |
|---|---|---|---|
| `commands` | none | none | `commands` with names, access and input requirements |
| `selfcheck` | write | none | runtime, binary SHA-256, database integrity, applied migrations, problems |
| `add` | write | `{id?, title, list?, priority?, estimate_days?, due?, assignee?, depends_on?, labels?, done_when?, notes?, idem_key?, actor?}` | `task` |
| `update` | write | `{id, patch, idem_key?, actor?}` | `task` |
| `status` | write | `{id, status, note?, reopen?, idem_key?, actor?}` | `task` |
| `dep add`, `dep rm` | write | `{task_id, depends_on, idem_key?, actor?}` | `task` |
| `get` | read | `{id}` | `tasks` containing one task |
| `list` | read | `{list?, status?, label?, assignee?}` | `tasks` |
| `import` | write | `{schemaVersion:1 or 2, tasks:[...], idem_key?, actor?}` | `created`, `updated`, `unchanged` counts |
| `next` | read | `{list?, limit?:10, assignee?}` | `ranked` with id, title, score and reasons |
| `graph` | read | `{list?}` | nodes, edges, critical_path, total_days, critical_path_days |
| `board` | read | `{list?}` | `columns`, each with a status and tasks |
| `counts` | read | `{list?}` | `list`, `exists`, `open`, `stale7d`, `blocked`, `waiting`, `done7d`, `asOf`, and `note` when the list does not exist |
| `history` | read | `{id}` | ordered `events` |
| `rebuild` | write | `{}` | counts of events replayed and tasks restored |
| `process metrics` | read | `{list?, from?, to?}` | status wait times, cycle-time percentiles, throughput and bottlenecks |
| `process simulate` | read | `{list?, scenarios:[{name, capacity_change?, wip_limit?}], runs}` | projected finish dates and durations for each scenario |
| `schedule suggest` | read | `{list?, people?:[...], horizon_days}` | `assignments` and `violations` |
| `schedule check` | read | `{assignments, people?:[...], horizon_days?}` | independently checked `violations` |

Reads open SQLite in read-only mode and cannot create or migrate a database. Run `selfcheck` first if a read reports `E_MIGRATION`. Writes apply pending forward-only migrations, then commit the event, task projection and request receipt together. A failed command rolls back its changes. Per-task event times must not move backward; a write with an earlier `--now` fails with `E_TIME`. Idempotency retries still return their original result. Dates must be valid calendar dates, and unrepresentable numeric results fail with `E_RANGE`.

## Tasks and dependencies

Statuses are `todo`, `in_progress`, `blocked`, `waiting`, `done` and `canceled`. Priority is an integer from 0 through 3, with 0 first. Estimates are days of effort. `update.patch` may change task details, but status changes use `status`, and prerequisites use `dep add` or `dep rm`. To reopen a done task, send `{ "id":"draft", "status":"todo", "reopen":true }`; ordinary updates and imports cannot reopen it.

Pass a distinct `idem_key` for each intended write and reuse it only when retrying that same request. A retry returns the original result even after later edits. A key reused with a different request fails with `E_IDEMPOTENCY`. No-op requests also reserve their keys. Keys are optional for interactive use, but bot skills require them.

Dependencies point from a task to its prerequisites. Missing prerequisites fail with `E_UNKNOWN_DEP`. A cycle fails with `E_CYCLE` and a closed path of task IDs in `data.cycle`. Neither failure stores any part of the change. Events cannot be updated or deleted through the database schema. `rebuild` replays the complete task and dependency snapshots recorded by events; it does not change history or request receipts.

### Import

Import envelopes accept `schemaVersion` 1 or 2 with the same task fields. An import task has `id`, `title`, optional task details, `depends_on`, optional `status`, optional `phase`, and optional `needs_go_ahead`. `phase` supplies the list when `list` is absent. `needs_go_ahead` becomes a `go:<text>` label. Omitted fields on existing tasks are preserved. All imported edges are checked together, so tasks may refer to later entries in the same input. Importing identical content twice reports zero created and zero updated on the second call.

```json
{"schemaVersion":1,"tasks":[{"id":"draft","title":"Prepare the draft","phase":"writing","estimate_days":1},{"id":"review","title":"Review the draft","phase":"writing","depends_on":["draft"],"estimate_days":0.5,"needs_go_ahead":"owner approval"}]}
```

The example dataset in `test/fixtures/work-plan.json` has 104 tasks and 105.5 estimated effort days. It exercises import, readiness and graph reporting with generic work items.

### Ranking and graph totals

`next` excludes done and canceled tasks, then requires every prerequisite to be done, including prerequisites in other lists. Canceled prerequisites do not count as done. Ready tasks sort by membership in the remaining critical path, earlier due date, lower priority number, smaller estimate, then ascending ID. Missing due dates and estimates sort last. Reasons expose each factor and explicitly flag approval labels; ranking never grants approval.

`graph.total_days` is the sum of estimates for selected tasks, including closed work. `critical_path_days` is the length of the longest dependency chain, which is a different number. Missing estimates contribute zero to these totals. A list-filtered graph reports selected nodes and their edges; the critical path includes the prerequisite closure so a prerequisite in another list is not silently ignored.

### Counts

`counts` returns the totals a status report needs for one list, so a caller never adds them up by hand. `list` is optional and matches the task's list name exactly, including letter case. When `list` is left out, `counts` uses the list named `default`, which is the list `add` and `import` put a task in when the task names no list. `data.list` always states the list that was counted. The command reads the database and changes nothing.

`data.exists` tells an empty list apart from a name that was never used. A list exists when at least one event in the task history records a task in that list. Lists are not created on their own: adding or importing a task into a list, or moving a task into it with `update`, is what makes it exist, and it keeps existing after its tasks are finished, canceled or moved to another list. When `exists` is `false`, every count is `null` rather than 0 and `data.note` names the lists that do exist, so a misspelled list name cannot be mistaken for a list with no open work. An unknown list is not an error; the command still succeeds.

```sh
printf '%s\n' '{"list":"default"}' | node ambitious-tasks-0.1.2.mjs counts --now 2026-01-15T12:00:00Z
```

For a list with four open tasks, `data` looks like this:

```json
{"list":"default","exists":true,"open":4,"stale7d":1,"blocked":1,"waiting":1,"done7d":2,"asOf":"2026-01-15T12:00:00.000Z"}
```

For a list name that no task has ever used, `data` looks like this:

```json
{"list":"defualt","exists":false,"open":null,"stale7d":null,"blocked":null,"waiting":null,"done7d":null,"asOf":"2026-01-15T12:00:00.000Z","note":"No task has ever been in the list \"defualt\", so there is nothing to count. Lists that have had a task: \"default\", \"review\"."}
```

| Field | Exact definition |
|---|---|
| `list` | The list that was counted: the list name from the input, or `default` when the input has no `list`. |
| `exists` | `true` when at least one event in the task history records a task in this list, whatever the task's status then or now and wherever the task is now. `false` when no task has ever been in it; the five counts are then `null`. |
| `open` | Tasks in the list whose status is `todo`, `in_progress`, `blocked` or `waiting`. Done and canceled tasks are not open. |
| `stale7d` | Open tasks whose last change is 7 or more days before `asOf`. The last change is the task's `updated_at`: the time of its most recent stored event of any kind (creation, edit, status change, dependency change or import). A task changed exactly 7 days (604,800,000 milliseconds) before `asOf` is stale; one changed a millisecond later is not. |
| `blocked` | Tasks in the list whose status is `blocked`. |
| `waiting` | Tasks in the list whose status is `waiting`. |
| `done7d` | Tasks in the list whose status is `done` and that were finished less than 7 days before `asOf`. The finish time is the most recent event that moved the task into `done`, so editing a task that was finished long ago does not count it again, while reopening and finishing it does. A task finished exactly 7 days before `asOf` is not counted. |
| `asOf` | The time the windows were measured from, in UTC: `--now` when given, otherwise the current time. It equals `meta.now`. |
| `note` | Present only when `exists` is `false`. A sentence that says no task has ever been in the list and names every list that exists, in sorted order, or says that no list has had a task yet. |

`blocked` and `waiting` are both included in `open`, and a stale task is also counted in `open`. Canceled tasks appear in no count. The counts describe the stored tasks as they are when the command runs; `--now` moves only the two 7-day windows and does not rewind task statuses to an earlier time.

## Read-only analysis

Metrics use status history up to `to` or `--now`, whichever comes first. `from` clips the measured window. Status waits are measured in elapsed days. Cycle time runs from entering `in_progress` to `done`, or from creation/reopening when work completed without an in-progress event. Percentiles use the nearest-rank method. Throughput counts completions in the window; reopened work can complete again. A bottleneck is a ranking of accumulated waiting time, not a claim about its cause.

Simulation uses estimates, dependencies and seeded duration samples. `capacity_change` is a fractional change relative to baseline capacity, so 1 doubles capacity and -0.5 halves it. `wip_limit` limits concurrent tasks. Results contain p50/p90 projected finish dates and durations. Unfinished prerequisites outside the selected scope can leave a scenario blocked. These are scenario estimates, not promises of actual delivery.

A person is `{id, name?, capacity_days_per_week, windows?:[{start,end}]}`. Windows use ISO timestamps with time zones; omitted or empty windows mean unrestricted availability. Capacity is effort days per seven elapsed calendar days. For example, one effort day at capacity 3.5 occupies two elapsed days. This is a calendar-time approximation, not a business-calendar optimizer. A task without an estimate uses one effort day for scheduling and simulation. Existing assignees constrain assignment. Suggestions do not persist people or change tasks; pass the same people to `schedule check` when checking a suggestion. Without a request roster, the commands read the existing `people` table.

An assignment is `{task_id, person_id, start, end}`. The independent checker detects overlaps, invalid availability, insufficient duration/capacity, prerequisite order, missing or repeated task/person IDs, and horizon violations. A bot decides whether to apply a suggestion through `update`; the module does not approve or execute work.

## Build and verify

Install [mise](https://mise.jdx.dev) and [elan](https://github.com/leanprover/elan), the Lean toolchain manager. Tool versions are pinned in `.mise.toml` and `proofs/lean-toolchain`. The checked kit release tarballs are vendored under `vendor/` and bundled at build time.

```sh
mise trust && mise install
npm ci
npm run release:check
verify/run
npm outdated
npm audit
```

`release:check` runs types, lint and standalone wording, import boundaries, unit/property and CLI tests, the shared contract tests, TLA+/TLC, Lean, feature verification and release packaging. `release:build` creates the single executable and checksum file in ignored `release/`. `verify/run --doctor`, `--list` and `--only <feature>` support targeted verification. Each feature uses a fresh `AMBITIOUS_HOME`, removes its test database afterward and retains its log.

The kit 0.1.1 read-only contract probe sends an empty object to every command. Commands such as `get` need a valid ID before opening a database; `counts` accepts the empty object as is. `scripts/contract.mjs` supplies valid command-specific inputs to that probe while preserving every shared assertion and testing the actual executable. The adapter fails if the upstream probe changes. A mutation test confirms that the adapted suite rejects a binary that opens analysis databases for writing. Vendored packages remain unchanged.

The TLA+ lifecycle model checks four tasks and the ordering invariants described in [spec/README.md](spec/README.md). Deliberately broken variants must fail their named invariants. Lean proves the reachability-based cycle check and next-task soundness for arbitrary graph sizes. Property tests compare the TypeScript cycle check with a brute-force evaluator on 10,000 generated graphs and check event replay against observed task state. Formal checks cover the stated models and assumptions, not every implementation detail. See [verify/formal/SKILL.md](verify/formal/SKILL.md) for the correspondence.

The [bot workflow skill](skills/tasks-for-bots/SKILL.md) and [Page skill](skills/tasks-page/SKILL.md) show how callers use the module. The bot renders Pages; this binary only returns data.

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md). Licensed under Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

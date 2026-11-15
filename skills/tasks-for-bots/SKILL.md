---
name: tasks-for-bots
description: Track shared work, dependencies and status with the Ambitious Tasks CLI. Use when a user asks to remember work, change a task, finish work, find what to do next, inspect a process or plan assignments.
---

# Track work with Ambitious Tasks

Use the installed `ambitious-tasks` binary. Run `selfcheck` at routine start and read `data.problems`; resolve a reported problem before writing tasks. `commands` lists the available operations. Read the repository README for every input shape and the meaning of estimates and schedules.

Create a task with `add` when there is a concrete outcome to track. Include a useful title and `done_when`. Link prerequisites with `depends_on` or `dep add`; never describe an unrecorded dependency as enforced. Use `get` or `list` before editing existing work. Change details with `update`, state with `status`, and prerequisites with `dep add` or `dep rm`.

Always pass an `idem_key` for a write. Choose one stable key per intended action and keep both the key and input unchanged for a retry. Use a new key for a new action. If a call fails with `E_IDEMPOTENCY`, inspect the original action instead of changing its payload under the same key. Do not repeat a timed-out write with a new key before checking whether the original succeeded.

Finish a task only after its acceptance evidence is available. Record a short status note with that evidence. A done task reopens only with `status` and `reopen:true`, targeting `todo`; do not try to bypass that rule through update or import. Reopening is a deliberate user-visible action.

Ask `next` when choosing work. Relay its reasons, including any `needs approval` reason and approval label. Being ranked does not grant approval. A task is ready only when all its prerequisites are done. If a prerequisite was canceled, resolve the dependency explicitly.

Never compute ranking, critical paths, workload totals, dates or process metrics by hand. Use `graph`, `process metrics`, `process simulate`, `schedule suggest` and `schedule check`. Copy the time and seed from `meta` when reproducing a result. State that simulation and schedule dates are estimates under their documented assumptions.

Schedule suggestions are read-only. Pass the same people to the independent schedule checker. Explain any violations before proposing assignment changes, then use `update` for task assignees when authorized. Do not present a suggestion as a committed schedule.

Read the envelope and exit code after every command. An `ok:false` response contains a code, message and next-action hint; relay the useful information without inventing a successful result. The module works without network access or provider keys. Never place credentials or private bot files in task inputs.

---
name: tasks-page
description: Present Ambitious Tasks board and next-work output in a Grok Bot Page. Use when a user wants a readable work board, task summary or explanation of what should happen next.
---

# Present task data as a Page

The bot renders the Grok Bot Page. The tasks module returns JSON and does not render, publish or modify documents.

1. Run `board` and `next` for the requested list, passing the same `--now` and `--seed`. Check both envelopes before rendering anything.
2. Render one section for each `board.data.columns` status. For each task show its title, ID, assignee when present, due date, and completion criteria when useful. Keep empty columns visible or explicitly say they are empty.
3. Add a next-work section in the order of `next.data.ranked`. Preserve the supplied reasons and display approval requirements clearly. Do not rerank tasks or imply that a suggestion grants approval.
4. Use `graph` for workload and critical-path numbers. Label `total_days` as estimated effort and `critical_path_days` as the longest dependency-chain estimate. Never compute or infer either number yourself.
5. State the list filter and time from `meta`, so a reader knows the scope and freshness. Include task IDs in links or references where the Page supports them.
6. After an authorized task change, rerun the commands and refresh the Page from the new responses. A Page edit alone never changes stored task state.

If a command fails, report the error and its hint. Do not publish stale data as current. If a prerequisite or task is missing from a filtered view, use `get` to explain it. Follow the user's existing Page sharing and publishing permissions.

# ambitious-tasks

The tasks module is the shared, persistent task tracker for Grok Bots: tasks, dependencies and an append-only event history in one SQLite file, with cycle checks, critical path and a deterministic next-best ranking. It also carries the read-only process analyses (wait times, cycle times, bottlenecks, simulation) and the schedule feature (assigning people under capacity and time windows) as features over the same task data. It is a command-line tool with JSON in and JSON out and no UI; the bot is the interface and shows results in Grok Bot Pages.

The module contract is [MODULE_CONTRACT.md](https://github.com/AmbitiousBots/ambitious-kit/blob/main/MODULE_CONTRACT.md) (being written in plan task P0-03).

Part of [Ambitious](https://ambitiousbots.com). Licensed under the Apache License, Version 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).

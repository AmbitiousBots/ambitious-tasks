import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMetrics } from "../src/domain/process-input.ts";
import { parseScheduleCheck, parseScheduleSuggest } from "../src/domain/schedule-input.ts";
import { items, object, run, scratch, success } from "./cli-helper.ts";

test("analysis rejects impossible calendar dates instead of moving them to another month", () => {
  const impossible = "2026-02-30T00:00:00Z";
  assert.throws(() => parseMetrics({ from: impossible }));
  assert.throws(() => parseScheduleSuggest({ horizon_days: 7, people: [{ id: "person", capacity_days_per_week: 5,
    windows: [{ start: impossible, end: "2026-03-10T00:00:00Z" }] }] }));
  assert.throws(() => parseScheduleCheck({ assignments: [{ task_id: "task", person_id: "person", start: impossible, end: "2026-03-10T00:00:00Z" }] }));
});

test("a reporting cutoff before the first task yields an empty valid time window", (t) => {
  const home = scratch(t);
  success(home, "add", { id: "one", title: "Later task" }, "2026-01-10T00:00:00Z");
  const result = success(home, "process metrics", { to: "2026-01-01T00:00:00Z" }, "2026-01-12T00:00:00Z");
  assert.equal(result.from, "2026-01-01T00:00:00.000Z");
  assert.equal(result.to, result.from);
  assert.deepEqual(result.throughput, { completed: 0, days: 0, tasks_per_day: 0 });
});

test("backdated changes fail atomically while retries retain their original response", (t) => {
  const home = scratch(t);
  const input = { id: "one", title: "Current", idem_key: "create" };
  const first = success(home, "add", input, "2026-01-10T00:00:00Z");
  const before = success(home, "history", { id: "one" });
  const status = run(home, "status", { id: "one", status: "in_progress" }, "2026-01-01T00:00:00Z");
  assert.equal(status.status, 1);
  assert.equal(object(items(status.envelope.errors)[0]).code, "E_TIME");
  const imported = run(home, "import", { schemaVersion: 2, tasks: [{ id: "new", title: "Earlier row" }, { id: "one", title: "Changed" }] });
  assert.equal(imported.status, 1);
  assert.equal(items(success(home, "list").tasks).length, 1);
  assert.deepEqual(success(home, "history", { id: "one" }), before);
  assert.deepEqual(success(home, "add", input, "2026-01-01T00:00:00Z"), first);
});

test("imports preserve omitted prerequisites and only clear them with an explicit empty array", (t) => {
  const home = scratch(t);
  success(home, "add", { id: "first", title: "First" });
  success(home, "add", { id: "second", title: "Second", depends_on: ["first"] });
  success(home, "import", { schemaVersion: 2, tasks: [{ id: "second", title: "Renamed" }] });
  assert.deepEqual(object(items(success(home, "get", { id: "second" }).tasks)[0]).depends_on, ["first"]);
  success(home, "import", { schemaVersion: 2, tasks: [{ id: "second", title: "Renamed", depends_on: [] }] });
  assert.deepEqual(object(items(success(home, "get", { id: "second" }).tasks)[0]).depends_on, []);
});

test("unrepresentable effort totals and projected dates return actionable errors", (t) => {
  const home = scratch(t);
  success(home, "add", { id: "one", title: "Large", estimate_days: 1e308 });
  success(home, "add", { id: "two", title: "Also large", estimate_days: 1e308 });
  for (const [command, input] of [["graph", {}], ["process simulate", { scenarios: [{ name: "base" }], runs: 1 }]] as const) {
    const result = run(home, command, input);
    assert.equal(result.status, 1);
    assert.equal(object(items(result.envelope.errors)[0]).code, "E_RANGE");
  }
});

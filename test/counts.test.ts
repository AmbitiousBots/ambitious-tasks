import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCounts } from "../src/domain/requests.ts";
import type { ProcessEvent } from "../src/domain/process.ts";
import { isTaskId, type Status, type Task, type TaskId } from "../src/domain/types.ts";
import { taskCounts } from "../src/domain/views.ts";
import { items, object, run, scratch, success } from "./cli-helper.ts";

const NOW = "2026-01-15T12:00:00.000Z";
const EXACTLY_SEVEN_DAYS_AGO = "2026-01-08T12:00:00.000Z";
const JUST_UNDER_SEVEN_DAYS_AGO = "2026-01-08T12:00:00.001Z";
const JUST_OVER_SEVEN_DAYS_AGO = "2026-01-08T11:59:59.999Z";

const id = (value: string): TaskId => {
  assert(isTaskId(value));
  return value;
};
const task = (value: string, status: Status, updatedAt: string, list = "audit"): Task => ({
  id: id(value), list, title: value, status, priority: 2, estimate_days: null,
  due: null, assignee: null, labels: [], done_when: null, notes: null,
  created_at: "2025-12-01T00:00:00.000Z", updated_at: updatedAt,
});
const timeline = (...steps: readonly (readonly [string, Status, string])[]): readonly ProcessEvent[] =>
  steps.map(([task_id, status, at], index) => ({ seq: index + 1, at, task_id: id(task_id), status }));

test("a list without tasks has zero for every count and echoes the list and time", () => {
  const other = task("elsewhere", "blocked", EXACTLY_SEVEN_DAYS_AGO, "other");
  assert.deepEqual(taskCounts([], [], NOW, "audit"), { list: "audit", open: 0, stale7d: 0, blocked: 0, waiting: 0, done7d: 0, asOf: NOW });
  assert.deepEqual(taskCounts([other], timeline(["elsewhere", "blocked", EXACTLY_SEVEN_DAYS_AGO]), NOW, "audit"),
    { list: "audit", open: 0, stale7d: 0, blocked: 0, waiting: 0, done7d: 0, asOf: NOW });
});

test("open counts todo, in progress, blocked and waiting tasks and leaves out done and canceled ones", () => {
  const tasks = [
    task("a", "todo", NOW), task("b", "in_progress", NOW), task("c", "blocked", NOW), task("d", "blocked", NOW),
    task("e", "waiting", NOW), task("f", "done", NOW), task("g", "canceled", NOW),
  ];
  const result = taskCounts(tasks, [], NOW, "audit");
  assert.equal(result.open, 5);
  assert.equal(result.blocked, 2);
  assert.equal(result.waiting, 1);
  assert.equal(result.stale7d, 0);
});

test("an open task becomes stale when its last change is exactly seven days old", () => {
  const stale = (updatedAt: string, status: Status = "todo"): number => taskCounts([task("a", status, updatedAt)], [], NOW, "audit").stale7d;
  assert.equal(stale(JUST_UNDER_SEVEN_DAYS_AGO), 0);
  assert.equal(stale(EXACTLY_SEVEN_DAYS_AGO), 1);
  assert.equal(stale(JUST_OVER_SEVEN_DAYS_AGO), 1);
  for (const status of ["in_progress", "blocked", "waiting"] as const) assert.equal(stale(EXACTLY_SEVEN_DAYS_AGO, status), 1);
  for (const status of ["done", "canceled"] as const) assert.equal(stale(JUST_OVER_SEVEN_DAYS_AGO, status), 0);
});

test("a done task counts as recently finished until its completion is exactly seven days old", () => {
  const done = (completedAt: string): number =>
    taskCounts([task("a", "done", completedAt)], timeline(["a", "todo", "2025-12-01T00:00:00.000Z"], ["a", "done", completedAt]), NOW, "audit").done7d;
  assert.equal(done(JUST_UNDER_SEVEN_DAYS_AGO), 1);
  assert.equal(done(EXACTLY_SEVEN_DAYS_AGO), 0);
  assert.equal(done(JUST_OVER_SEVEN_DAYS_AGO), 0);
});

test("editing a task finished long ago does not make it recently finished, but finishing it again does", () => {
  const long = "2025-12-10T00:00:00.000Z";
  const edited = timeline(["a", "todo", "2025-12-01T00:00:00.000Z"], ["a", "done", long], ["a", "done", NOW]);
  assert.equal(taskCounts([task("a", "done", NOW)], edited, NOW, "audit").done7d, 0);
  const redone = timeline(["a", "done", long], ["a", "todo", "2026-01-14T00:00:00.000Z"], ["a", "done", NOW]);
  assert.equal(taskCounts([task("a", "done", NOW)], redone, NOW, "audit").done7d, 1);
  assert.equal(taskCounts([task("a", "canceled", NOW)], timeline(["a", "canceled", NOW]), NOW, "audit").done7d, 0);
});

test("counts requires exactly one nonempty list name", () => {
  assert.deepEqual(parseCounts({ list: "audit" }), { list: "audit" });
  for (const input of [{}, { list: "" }, { list: 7 }, { list: "audit", status: "todo" }, null]) assert.throws(() => parseCounts(input));
});

test("the counts command reads stored tasks at the seven-day boundary without changing them", (t) => {
  const home = scratch(t);
  const start = "2026-01-01T00:00:00Z";
  for (const name of ["quiet", "edited", "stuck", "paused", "finished", "dropped"]) success(home, "add", { id: name, title: name, list: "audit" }, start);
  success(home, "add", { id: "elsewhere", title: "elsewhere", list: "other" }, start);
  success(home, "update", { id: "edited", patch: { notes: "Checked" } }, "2026-01-01T00:00:00.001Z");
  success(home, "status", { id: "stuck", status: "blocked" }, start);
  success(home, "status", { id: "paused", status: "waiting" }, "2026-01-04T00:00:00Z");
  success(home, "status", { id: "finished", status: "done" }, "2026-01-01T00:00:00.001Z");
  success(home, "status", { id: "dropped", status: "canceled" }, "2026-01-04T00:00:00Z");
  const before = success(home, "list");
  assert.deepEqual(success(home, "counts", { list: "audit" }, "2026-01-08T00:00:00Z"),
    { list: "audit", open: 4, stale7d: 2, blocked: 1, waiting: 1, done7d: 1, asOf: "2026-01-08T00:00:00.000Z" });
  assert.deepEqual(success(home, "counts", { list: "audit" }, "2026-01-08T00:00:00.001Z"),
    { list: "audit", open: 4, stale7d: 3, blocked: 1, waiting: 1, done7d: 0, asOf: "2026-01-08T00:00:00.001Z" });
  assert.deepEqual(success(home, "counts", { list: "nothing-here" }, "2026-01-08T00:00:00Z"),
    { list: "nothing-here", open: 0, stale7d: 0, blocked: 0, waiting: 0, done7d: 0, asOf: "2026-01-08T00:00:00.000Z" });
  assert.deepEqual(success(home, "list"), before);
});

test("counts without a list is rejected before a database is opened", (t) => {
  const result = run(scratch(t), "counts", {});
  assert.equal(result.status, 1);
  assert.equal(object(items(result.envelope.errors)[0]).code, "E_INPUT_SCHEMA");
});

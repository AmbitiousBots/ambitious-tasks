import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { parseCounts } from "../src/domain/requests.ts";
import type { ProcessEvent } from "../src/domain/process.ts";
import { isTaskId, type Status, type Task, type TaskId } from "../src/domain/types.ts";
import { taskCounts } from "../src/domain/views.ts";
import { object, scratch, success } from "./cli-helper.ts";

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

const counted = (tasks: readonly Task[], events: readonly ProcessEvent[] = []) => {
  const result = taskCounts(tasks, events, NOW, "audit", ["audit"]);
  assert(result.exists);
  return result;
};

test("a list that never had a task reports that it does not exist, with no numbers and the lists that do", () => {
  const other = task("elsewhere", "blocked", EXACTLY_SEVEN_DAYS_AGO, "other");
  const blank = { list: "audit", exists: false, open: null, stale7d: null, blocked: null, waiting: null, done7d: null, asOf: NOW };
  assert.deepEqual(taskCounts([], [], NOW, "audit", []), { ...blank,
    note: 'No task has ever been in the list "audit", so there is nothing to count. No list has had a task yet.' });
  assert.deepEqual(taskCounts([other], timeline(["elsewhere", "blocked", EXACTLY_SEVEN_DAYS_AGO]), NOW, "audit", ["default", "other"]), { ...blank,
    note: 'No task has ever been in the list "audit", so there is nothing to count. Lists that have had a task: "default", "other".' });
});

test("a list that had a task but holds none now exists and has zero for every count", () => {
  assert.deepEqual(taskCounts([], [], NOW, "audit", ["audit"]),
    { list: "audit", exists: true, open: 0, stale7d: 0, blocked: 0, waiting: 0, done7d: 0, asOf: NOW });
});

test("a list with only done and canceled tasks exists and has no open work", () => {
  const long = "2025-12-10T00:00:00.000Z";
  const tasks = [task("a", "done", long), task("b", "canceled", long)];
  assert.deepEqual(counted(tasks, timeline(["a", "done", long], ["b", "canceled", long])),
    { list: "audit", exists: true, open: 0, stale7d: 0, blocked: 0, waiting: 0, done7d: 0, asOf: NOW });
});

test("open counts todo, in progress, blocked and waiting tasks and leaves out done and canceled ones", () => {
  const tasks = [
    task("a", "todo", NOW), task("b", "in_progress", NOW), task("c", "blocked", NOW), task("d", "blocked", NOW),
    task("e", "waiting", NOW), task("f", "done", NOW), task("g", "canceled", NOW),
  ];
  const result = counted(tasks);
  assert.equal(result.open, 5);
  assert.equal(result.blocked, 2);
  assert.equal(result.waiting, 1);
  assert.equal(result.stale7d, 0);
});

test("an open task becomes stale when its last change is exactly seven days old", () => {
  const stale = (updatedAt: string, status: Status = "todo"): number => counted([task("a", status, updatedAt)]).stale7d;
  assert.equal(stale(JUST_UNDER_SEVEN_DAYS_AGO), 0);
  assert.equal(stale(EXACTLY_SEVEN_DAYS_AGO), 1);
  assert.equal(stale(JUST_OVER_SEVEN_DAYS_AGO), 1);
  for (const status of ["in_progress", "blocked", "waiting"] as const) assert.equal(stale(EXACTLY_SEVEN_DAYS_AGO, status), 1);
  for (const status of ["done", "canceled"] as const) assert.equal(stale(JUST_OVER_SEVEN_DAYS_AGO, status), 0);
});

test("a done task counts as recently finished until its completion is exactly seven days old", () => {
  const done = (completedAt: string): number =>
    counted([task("a", "done", completedAt)], timeline(["a", "todo", "2025-12-01T00:00:00.000Z"], ["a", "done", completedAt])).done7d;
  assert.equal(done(JUST_UNDER_SEVEN_DAYS_AGO), 1);
  assert.equal(done(EXACTLY_SEVEN_DAYS_AGO), 0);
  assert.equal(done(JUST_OVER_SEVEN_DAYS_AGO), 0);
});

test("editing a task finished long ago does not make it recently finished, but finishing it again does", () => {
  const long = "2025-12-10T00:00:00.000Z";
  const edited = timeline(["a", "todo", "2025-12-01T00:00:00.000Z"], ["a", "done", long], ["a", "done", NOW]);
  assert.equal(counted([task("a", "done", NOW)], edited).done7d, 0);
  const redone = timeline(["a", "done", long], ["a", "todo", "2026-01-14T00:00:00.000Z"], ["a", "done", NOW]);
  assert.equal(counted([task("a", "done", NOW)], redone).done7d, 1);
  assert.equal(counted([task("a", "canceled", NOW)], timeline(["a", "canceled", NOW])).done7d, 0);
});

test("counts takes one list name and falls back to the list that add uses when none is given", () => {
  assert.deepEqual(parseCounts({ list: "audit" }), { list: "audit" });
  assert.deepEqual(parseCounts({}), { list: "default" });
  for (const input of [{ list: "" }, { list: 7 }, { list: null }, { list: "audit", status: "todo" }, null]) assert.throws(() => parseCounts(input));
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
    { list: "audit", exists: true, open: 4, stale7d: 2, blocked: 1, waiting: 1, done7d: 1, asOf: "2026-01-08T00:00:00.000Z" });
  assert.deepEqual(success(home, "counts", { list: "audit" }, "2026-01-08T00:00:00.001Z"),
    { list: "audit", exists: true, open: 4, stale7d: 3, blocked: 1, waiting: 1, done7d: 0, asOf: "2026-01-08T00:00:00.001Z" });
  assert.deepEqual(success(home, "counts", { list: "nothing-here" }, "2026-01-08T00:00:00Z"),
    { list: "nothing-here", exists: false, open: null, stale7d: null, blocked: null, waiting: null, done7d: null, asOf: "2026-01-08T00:00:00.000Z",
      note: 'No task has ever been in the list "nothing-here", so there is nothing to count. Lists that have had a task: "audit", "other".' });
  assert.deepEqual(success(home, "list"), before);
});

test("counts without a list reports the list that add uses when no list is given", (t) => {
  const home = scratch(t);
  const at = "2026-01-02T00:00:00Z";
  success(home, "selfcheck");
  const fresh = success(home, "counts", {}, at);
  assert.equal(fresh.list, "default");
  assert.equal(fresh.exists, false);
  assert.equal(fresh.open, null);
  success(home, "add", { id: "unfiled", title: "unfiled" });
  success(home, "add", { id: "filed", title: "filed", list: "audit" });
  const expected = { list: "default", exists: true, open: 1, stale7d: 0, blocked: 0, waiting: 0, done7d: 0, asOf: "2026-01-02T00:00:00.000Z" };
  assert.deepEqual(success(home, "counts", {}, at), expected);
  assert.deepEqual(success(home, "counts", { list: "default" }, at), expected);
  const noInput = spawnSync(process.execPath, ["dist/ambitious-tasks.mjs", "counts", "--now", at], { input: "", encoding: "utf8", env: { ...process.env, AMBITIOUS_HOME: home } });
  const answer: unknown = JSON.parse(noInput.stdout);
  assert.deepEqual(object(answer).data, expected);
});

test("a stored list whose tasks are all done or canceled exists with zero open, unlike a list that was never used", (t) => {
  const home = scratch(t);
  success(home, "add", { id: "finished", title: "finished", list: "closed" });
  success(home, "add", { id: "dropped", title: "dropped", list: "closed" });
  success(home, "status", { id: "finished", status: "done" });
  success(home, "status", { id: "dropped", status: "canceled" });
  assert.deepEqual(success(home, "counts", { list: "closed" }, "2026-01-05T00:00:00Z"),
    { list: "closed", exists: true, open: 0, stale7d: 0, blocked: 0, waiting: 0, done7d: 1, asOf: "2026-01-05T00:00:00.000Z" });
  assert.deepEqual(success(home, "counts", { list: "closed" }, "2026-02-01T00:00:00Z"),
    { list: "closed", exists: true, open: 0, stale7d: 0, blocked: 0, waiting: 0, done7d: 0, asOf: "2026-02-01T00:00:00.000Z" });
  assert.equal(success(home, "counts", { list: "Closed" }).exists, false);
});

test("a list keeps existing after its only task moves to another list, and after a rebuild", (t) => {
  const home = scratch(t);
  success(home, "add", { id: "moved", title: "moved", list: "inbox" });
  success(home, "update", { id: "moved", patch: { list: "audit" } });
  const emptied = { list: "inbox", exists: true, open: 0, stale7d: 0, blocked: 0, waiting: 0, done7d: 0, asOf: "2026-01-01T00:00:00.000Z" };
  assert.deepEqual(success(home, "counts", { list: "inbox" }), emptied);
  assert.equal(success(home, "counts", { list: "audit" }).open, 1);
  success(home, "rebuild");
  assert.deepEqual(success(home, "counts", { list: "inbox" }), emptied);
});

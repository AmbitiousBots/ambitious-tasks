import assert from "node:assert/strict";
import { test } from "node:test";
import { items, object, scratch, success } from "./cli-helper.ts";

const boardTasks = (home: string) => new Map(items(success(home, "board").columns)
  .flatMap((column) => items(object(column).tasks)).map(object).map((task) => [task.id, task]));

test("each next item carries the same display fields as its board task, plus score and reasons", (t) => {
  const home = scratch(t);
  success(home, "add", { id: "full", title: "Fully described", list: "review", priority: 1, estimate_days: 2, due: "2026-02-01",
    assignee: "member", labels: ["planned"], done_when: "Accepted", notes: "Context" });
  success(home, "add", { id: "bare", title: "Barely described" });
  success(home, "status", { id: "bare", status: "in_progress" });
  const board = boardTasks(home);
  const ranked = items(success(home, "next").ranked).map(object);
  assert.deepEqual(ranked.map(({ id }) => id), ["full", "bare"]);
  for (const item of ranked) {
    const { score, reasons, ...fields } = item;
    assert.deepEqual(fields, board.get(item.id));
    assert.equal(typeof score, "number");
    assert.ok(items(reasons).length > 0);
  }
  const [full, bare] = ranked.map(object);
  assert.ok(full !== undefined && bare !== undefined);
  assert.equal(full.title, "Fully described");
  assert.equal(full.assignee, "member");
  assert.equal(full.due, "2026-02-01T00:00:00.000Z");
  assert.equal(full.priority, 1);
  assert.equal(full.status, "todo");
  assert.equal(full.list, "review");
  assert.equal(full.estimate_days, 2);
  assert.deepEqual(full.labels, ["planned"]);
  assert.ok(items(full.reasons).includes("due 2026-02-01T00:00:00.000Z"));
  assert.ok(items(full.reasons).includes("priority 1"));

  for (const field of ["assignee", "due", "estimate_days", "done_when", "notes"]) {
    assert.ok(Object.hasOwn(bare, field), field);
    assert.equal(bare[field], null);
  }
  assert.equal(bare.priority, 2);
  assert.equal(bare.status, "in_progress");
  assert.ok(items(bare.reasons).includes("no due date"));
  assert.ok(items(bare.reasons).includes("priority 2"));
  assert.equal(Object.hasOwn(bare, "depends_on"), false);
});

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { items, object, run, scratch, success } from "./cli-helper.ts";

const LATER = "2026-01-02T00:00:00Z";
const errorCode = (result: ReturnType<typeof run>): unknown => object(items(result.envelope.errors)[0]).code;
const events = (home: string, id: string) => items(success(home, "history", { id }).events).map(object);

test("list move keeps the task id and every field except list and updated_at, and records the move in history", (t) => {
  const home = scratch(t);
  success(home, "add", { id: "prerequisite", title: "First" });
  const added = object(success(home, "add", {
    id: "one", title: "Filed in the wrong list", list: "inbox", priority: 1, estimate_days: 2, due: "2026-02-01",
    assignee: "member", labels: ["planned"], done_when: "Accepted", notes: "Keep", depends_on: ["prerequisite"],
  }).task);
  const result = success(home, "list move", { id: "one", list: "review", idem_key: "move-one", actor: "operator" }, LATER);
  assert.equal(result.moved, true);
  assert.equal(result.from_list, "inbox");
  assert.deepEqual(result.task, { ...added, list: "review", updated_at: "2026-01-02T00:00:00.000Z" });

  assert.deepEqual(items(success(home, "get", { id: "one" }).tasks), [result.task]);
  assert.deepEqual(items(success(home, "list", { list: "review" }).tasks).map((task) => object(task).id), ["one"]);
  assert.deepEqual(items(success(home, "list", { list: "inbox" }).tasks), []);
  const boardIds = (list: string) => items(success(home, "board", { list }).columns)
    .flatMap((column) => items(object(column).tasks)).map((task) => object(task).id);
  assert.deepEqual(boardIds("review"), ["one"]);
  assert.deepEqual(boardIds("inbox"), []);

  const history = events(home, "one");
  assert.deepEqual(history.map(({ kind }) => kind), ["created", "updated"]);
  const move = object(history[1]);
  assert.equal(move.actor, "operator");
  assert.equal(move.idem_key, "move-one");
  const payload = object(move.payload);
  assert.deepEqual(payload.list_move, { from: "inbox", to: "review" });
  assert.equal(object(payload.task).list, "review");
  assert.deepEqual(payload.depends_on, ["prerequisite"]);
});

test("a repeated list move with the same key stores one event, and the key refuses a different list", (t) => {
  const home = scratch(t);
  success(home, "add", { id: "one", title: "Task", list: "inbox" });
  const input = { id: "one", list: "review", idem_key: "move-one" };
  const first = success(home, "list move", input, LATER);
  assert.deepEqual(success(home, "list move", input, "2026-01-03T00:00:00Z"), first);
  assert.equal(events(home, "one").length, 2);
  const conflict = run(home, "list move", { ...input, list: "archive" }, LATER);
  assert.equal(conflict.status, 1);
  assert.equal(errorCode(conflict), "E_IDEMPOTENCY");
  assert.equal(object(items(success(home, "get", { id: "one" }).tasks)[0]).list, "review");
  assert.equal(events(home, "one").length, 2);
});

test("moving a task to the list it is already in succeeds, stores no event and still reserves its key", (t) => {
  const home = scratch(t);
  const added = success(home, "add", { id: "one", title: "Task", list: "inbox" }).task;
  const input = { id: "one", list: "inbox", idem_key: "stay" };
  const result = success(home, "list move", input, LATER);
  assert.deepEqual(result, { task: added, moved: false, from_list: "inbox" });
  assert.equal(events(home, "one").length, 1);
  success(home, "list move", { id: "one", list: "review" }, LATER);
  assert.deepEqual(success(home, "list move", input, LATER), result);
  assert.equal(errorCode(run(home, "list move", { id: "one", list: "archive", idem_key: "stay" }, LATER)), "E_IDEMPOTENCY");
});

test("list move rejects a blank list before a database exists and reports an unknown task", (t) => {
  const home = scratch(t);
  for (const input of [{ id: "one", list: "" }, { id: "one", list: "   " }, { id: "one" }, { list: "review" }, { id: "one", list: "review", extra: true }]) {
    const result = run(home, "list move", input);
    assert.equal(result.status, 1);
    assert.equal(errorCode(result), "E_INPUT_SCHEMA");
  }
  assert.equal(existsSync(join(home, "tasks/tasks.sqlite")), false);
  const missing = run(home, "list move", { id: "absent", list: "review" });
  assert.equal(missing.status, 1);
  assert.equal(errorCode(missing), "E_NOT_FOUND");
});

test("update with patch.list still moves a task and records the same list_move entry only for a real list change", (t) => {
  const home = scratch(t);
  success(home, "add", { id: "one", title: "Task", list: "inbox" });
  const moved = object(success(home, "update", { id: "one", patch: { list: "review", title: "Renamed" } }, LATER).task);
  assert.equal(moved.id, "one");
  assert.equal(moved.list, "review");
  success(home, "update", { id: "one", patch: { list: "review", notes: "Same list" } }, LATER);
  const payloads = events(home, "one").map((event) => object(event.payload));
  assert.deepEqual(payloads.map((payload) => payload.list_move), [undefined, { from: "inbox", to: "review" }, undefined]);
  const before = success(home, "list");
  success(home, "rebuild");
  assert.deepEqual(success(home, "list"), before);
  assert.equal(success(home, "counts", { list: "inbox" }).exists, true);
});

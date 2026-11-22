import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseScheduleSuggest } from "../src/domain/schedule-input.ts";
import { suggestSchedule, type Person } from "../src/domain/schedule.ts";
import { isTaskId, type Graph, type Task, type TaskId } from "../src/domain/types.ts";
import { items, object, run, scratch, success } from "./cli-helper.ts";

const now = "2026-01-01T00:00:00.000Z";
const id = (raw: string): TaskId => {
  assert(isTaskId(raw));
  return raw;
};
const task = (raw: string, patch: Partial<Task> = {}): Task => ({
  id: id(raw), title: raw, list: "default", status: "todo", priority: 2, estimate_days: 1,
  due: null, assignee: null, labels: [], done_when: null, notes: null, created_at: now, updated_at: now, ...patch,
});
const graph: Graph = new Map([[id("a"), new Set<TaskId>()]]);
const member: Person = { id: "member", capacity_days_per_week: 7, windows: [] };
const hashDb = (home: string): string => createHash("sha256").update(readFileSync(join(home, "tasks/tasks.sqlite"))).digest("hex");
const ROSTER_FIELDS = ["schedule suggest", "people", "windows", "capacity_days_per_week"];

test("a schedule suggest body without horizon_days names both horizon_days and the people roster before any database exists", (t) => {
  const home = scratch(t);
  const result = run(home, "schedule suggest", { list: "default" });
  assert.equal(result.status, 1);
  const error = object(items(result.envelope.errors)[0]);
  assert.equal(error.code, "E_INPUT_SCHEMA");
  assert.equal(typeof error.message, "string");
  assert.equal(typeof error.hint, "string");
  for (const field of ["horizon_days", "people", "capacity_days_per_week", "windows"]) assert.match(String(error.message), new RegExp(field));
  for (const field of ["horizon_days", "people", "capacity_days_per_week", "windows", "NO_FEASIBLE_SLOT"]) assert.match(String(error.hint), new RegExp(field));
  assert.equal(existsSync(join(home, "tasks/tasks.sqlite")), false);

  const rosterOnly = object(items(run(home, "schedule suggest", { people: [member] }).envelope.errors)[0]);
  assert.equal(rosterOnly.code, "E_INPUT_SCHEMA");
  assert.match(String(rosterOnly.message), /horizon_days/);
  assert.match(String(rosterOnly.hint), /people/);
});

test("people stays optional for schedule suggest and the hint's example body parses", () => {
  assert.deepEqual(parseScheduleSuggest({ horizon_days: 14 }), { horizon_days: 14 });
  let hint = "";
  try {
    parseScheduleSuggest({});
  } catch (error) {
    hint = JSON.stringify(error);
  }
  const example = /for example (\{.*\}\]\}\]\})\. /.exec(String(object(items(object(JSON.parse(hint)).errors)[0]).hint))?.[1];
  assert.ok(example !== undefined);
  assert.equal(parseScheduleSuggest(JSON.parse(example)).people?.length, 1);
});

test("NO_FEASIBLE_SLOT says whether the roster is empty, the assignee is missing from it, or nobody has room", () => {
  const explain = (tasks: readonly Task[], stored: readonly Person[], people?: readonly Person[], horizon = 7) => {
    const violation = suggestSchedule(tasks, graph, stored, now, { horizon_days: horizon, ...(people === undefined ? {} : { people }) }).violations[0];
    assert.equal(violation?.code, "NO_FEASIBLE_SLOT");
    assert.equal(violation.task_id, "a");
    for (const field of ROSTER_FIELDS) assert.ok(violation.hint?.includes(field), field);
    return violation;
  };
  const stored = explain([task("a")], []);
  assert.equal(stored.reason, "EMPTY_ROSTER");
  assert.match(stored.message, /no people roster/);
  assert.match(stored.message, /stored people table is empty/);
  const sent = explain([task("a")], [member], []);
  assert.equal(sent.reason, "EMPTY_ROSTER");
  assert.match(sent.message, /roster in the request is empty/);
  const absent = explain([task("a", { assignee: "absent" })], [], [member]);
  assert.equal(absent.reason, "ASSIGNEE_NOT_IN_ROSTER");
  assert.match(absent.message, /"absent"/);
  const short = explain([task("a", { estimate_days: 3 })], [], [member], 2);
  assert.equal(short.reason, "NO_ROOM");
  assert.match(short.hint ?? "", /horizon_days/);
  assert.equal(explain([task("a")], [], [{ ...member, capacity_days_per_week: 0 }]).reason, "NO_ROOM");
  assert.equal(explain([task("a", { assignee: "member" })], [], [{ ...member, windows: [{ start: now, end: "2026-01-01T12:00:00.000Z" }] }]).reason, "NO_ROOM");
});

test("schedule suggest with only a horizon explains the missing roster for every task and changes nothing", (t) => {
  const home = scratch(t);
  success(home, "add", { id: "one", title: "First" });
  success(home, "add", { id: "two", title: "Second", assignee: "member" });
  const before = hashDb(home);
  const tasksBefore = success(home, "list");
  const result = success(home, "schedule suggest", { list: "default", horizon_days: 14 });
  assert.deepEqual(result.assignments, []);
  const violations = items(result.violations).map(object);
  assert.deepEqual(violations.map(({ task_id }) => task_id).sort(), ["one", "two"]);
  for (const violation of violations) {
    assert.equal(violation.code, "NO_FEASIBLE_SLOT");
    assert.equal(violation.reason, "EMPTY_ROSTER");
    for (const field of ROSTER_FIELDS) assert.match(String(violation.hint), new RegExp(field));
  }
  const withRoster = success(home, "schedule suggest", { horizon_days: 14, people: [{ id: "member", capacity_days_per_week: 7 }] });
  assert.equal(items(withRoster.assignments).length, 2);
  assert.deepEqual(withRoster.violations, []);
  assert.deepEqual(success(home, "schedule suggest", { list: "default", horizon_days: 14 }), result);
  assert.deepEqual(success(home, "list"), tasksBefore);
  assert.equal(hashDb(home), before);
});

test("the README schedule suggest example runs as written and stores nothing", (t) => {
  const line = readFileSync("README.md", "utf8").split("\n").find((text) => text.startsWith("printf") && text.includes(" schedule suggest "));
  assert.ok(line !== undefined, "README.md must keep its schedule suggest example on one line");
  const match = /^printf '%s\\n' '(\{.*\})' \| node ambitious-tasks-[0-9.]+\.mjs schedule suggest --now (\S+)$/.exec(line);
  assert.ok(match !== null, line);
  const [, body = "", at = ""] = match;
  const input = object(JSON.parse(body));
  assert.equal(input.horizon_days, 14);
  assert.equal(items(input.people).length, 1);
  assert.equal(Object.hasOwn(object(items(input.people)[0]), "tz"), false);
  const home = scratch(t);
  success(home, "add", { id: "draft", title: "Prepare the draft", estimate_days: 1 });
  const before = hashDb(home);
  const result = success(home, "schedule suggest", input, at);
  const shown = readFileSync("README.md", "utf8").split("\n").find((text) => text.startsWith('{"assignments":'));
  assert.ok(shown !== undefined, "README.md must show the example result");
  assert.deepEqual(result, JSON.parse(shown));
  assert.equal(items(result.assignments).length, 1);
  assert.deepEqual(result.violations, []);
  assert.equal(hashDb(home), before);
});

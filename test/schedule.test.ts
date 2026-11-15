import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { parsePeople, parseScheduleCheck, parseScheduleSuggest } from "../src/domain/schedule-input.ts";
import { checkSchedule, suggestSchedule, type Assignment, type Person } from "../src/domain/schedule.ts";
import { isTaskId, type Graph, type Task, type TaskId } from "../src/domain/types.ts";

const now = "2026-01-01T00:00:00.000Z";
const id = (raw: string): TaskId => {
  assert(isTaskId(raw));
  return raw;
};
const task = (raw: string, patch: Partial<Task> = {}): Task => ({
  id: id(raw), title: raw, list: "default", status: "todo", priority: 2, estimate_days: 1,
  due: null, assignee: null, labels: [], done_when: null, notes: null, created_at: now, updated_at: now, ...patch,
});
const people: readonly Person[] = [{ id: "member", capacity_days_per_week: 7, windows: [] }];
const graph: Graph = new Map([[id("a"), new Set<TaskId>()], [id("b"), new Set([id("a")])]]);
const assignments: readonly Assignment[] = [
  { task_id: id("a"), person_id: "member", start: now, end: "2026-01-02T00:00:00.000Z" },
  { task_id: id("b"), person_id: "member", start: "2026-01-02T00:00:00.000Z", end: "2026-01-03T00:00:00.000Z" },
];

test("schedule suggestions respect prerequisites and pass an independent check", () => {
  const tasks = [task("b"), task("a")];
  const result = suggestSchedule(tasks, graph, people, now, { horizon_days: 7 });
  assert.deepEqual(result, { assignments, violations: [] });
  assert.deepEqual(checkSchedule(tasks, graph, people, now, { assignments: result.assignments, horizon_days: 7 }), { violations: [] });
  assert.deepEqual(suggestSchedule([...tasks].reverse(), graph, people, now, { horizon_days: 7 }), result);
});

test("capacity scales elapsed duration and availability windows constrain assignments", () => {
  const roster: readonly Person[] = [{ id: "member", capacity_days_per_week: 3.5, windows: [{ start: "2026-01-02T00:00:00.000Z", end: "2026-01-05T00:00:00.000Z" }] }];
  const result = suggestSchedule([task("a")], graph, roster, now, { horizon_days: 7 });
  assert.deepEqual(result.assignments, [{ task_id: "a", person_id: "member", start: "2026-01-02T00:00:00.000Z", end: "2026-01-04T00:00:00.000Z" }]);
  assert.deepEqual(result.violations, []);
  assert.equal(suggestSchedule([task("a"), task("b")], graph, roster, now, { horizon_days: 7 }).violations[0]?.code, "NO_FEASIBLE_SLOT");
});

test("planner preserves assignee constraints and reports unavailable capacity and unscheduled dependencies", () => {
  const tasks = [task("a", { assignee: "absent" }), task("b")];
  const result = suggestSchedule(tasks, graph, people, now, { horizon_days: 7 });
  assert.deepEqual(result.assignments, []);
  assert.deepEqual(result.violations.map(({ code }) => code), ["NO_FEASIBLE_SLOT", "DEPENDENCY_OPEN"]);
  assert.equal(suggestSchedule([task("a")], graph, [], now, { horizon_days: 7 }).violations[0]?.code, "NO_FEASIBLE_SLOT");
  assert.equal(suggestSchedule([task("a", { list: "other" }), task("b")], graph, people, now, { list: "default", horizon_days: 7 }).violations[0]?.code, "DEPENDENCY_OPEN");
});

test("planner uses finished prerequisites outside the selected list and picks the earliest finish deterministically", () => {
  const roster: readonly Person[] = [{ id: "slow", capacity_days_per_week: 3.5, windows: [] }, { id: "fast", capacity_days_per_week: 7, windows: [] }];
  const tasks = [task("a", { status: "done", list: "other" }), task("b")];
  const result = suggestSchedule(tasks, graph, roster, now, { list: "default", horizon_days: 7 });
  assert.equal(result.assignments[0]?.person_id, "fast");
  assert.equal(result.assignments[0]?.start, now);
  assert.deepEqual(suggestSchedule(tasks, graph, [...roster].reverse(), now, { list: "default", horizon_days: 7 }), result);
});

test("independent checker detects overlapping assignments and unsatisfied dependencies", () => {
  const concurrent = assignments.map((assignment) => ({ ...assignment, start: now, end: "2026-01-02T00:00:00.000Z" }));
  const codes = checkSchedule([task("a"), task("b")], graph, people, now, { assignments: concurrent }).violations.map(({ code }) => code);
  assert(codes.includes("OVERLAP"));
  assert(codes.includes("DEPENDENCY_OPEN"));
});

test("independent checker detects invalid duration capacity windows horizon duplicates and unknown identifiers", () => {
  const first = assignments[0];
  assert(first !== undefined);
  const roster: readonly Person[] = [{ id: "member", capacity_days_per_week: 3.5, windows: [{ start: "2026-01-02T00:00:00.000Z", end: "2026-01-04T00:00:00.000Z" }] }];
  const checked = checkSchedule([task("a", { assignee: "another" })], graph, roster, now, { assignments: [first, first, { ...first, task_id: id("missing"), person_id: "missing" }], horizon_days: 0 });
  const codes = checked.violations.map(({ code }) => code);
  for (const code of ["CAPACITY_EXCEEDED", "OUTSIDE_WINDOW", "OUTSIDE_HORIZON", "DUPLICATE_TASK", "UNKNOWN_TASK", "UNKNOWN_PERSON", "ASSIGNEE_MISMATCH"]) assert(codes.includes(code), code);
  assert.equal(checkSchedule([task("a")], graph, people, now, { assignments: [{ ...first, end: "2026-01-03T00:00:00.000Z" }] }).violations[0]?.code, "DURATION_MISMATCH");
});

test("schedule parsers validate timestamps capacities duplicate people and required arrays before IO", () => {
  assert.throws(() => parseScheduleSuggest({ horizon_days: -1 }));
  assert.throws(() => parseScheduleSuggest({ horizon_days: Infinity }));
  assert.throws(() => parseScheduleSuggest({ horizon_days: 7, people: [{ id: "member", capacity_days_per_week: 8 }] }));
  assert.throws(() => parsePeople([...people, ...people]));
  assert.throws(() => parsePeople([{ id: "member", capacity_days_per_week: 7, windows: [{ start: now, end: now }] }]));
  assert.throws(() => parseScheduleCheck({ assignments: [{ task_id: "a", person_id: "member", start: "2026-01-01", end: now }] }));
  assert.throws(() => parseScheduleCheck({}));
  assert.throws(() => parseScheduleCheck({ assignments, extra: "ignored" }));
  assert.throws(() => parseScheduleSuggest({ horizon_days: 7, people: [{ id: "member", capacity_days_per_week: 7, extra: "ignored" }] }));
  assert.deepEqual(parseScheduleCheck({ assignments, people }), { assignments, people });
  assert.deepEqual(parsePeople([{ id: "member", capacity_days_per_week: 7 }]), people);
});


test("suggested assignments satisfy the checker across generated workloads and capacities", () => {
  fc.assert(fc.property(
    fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 8, maxLength: 8 }),
    fc.array(fc.boolean(), { minLength: 64, maxLength: 64 }),
    fc.integer({ min: 1, max: 7 }),
    (estimates, edges, capacity) => {
      const tasks = estimates.map((estimate, index) => task(`task-${index}`, { estimate_days: estimate }));
      const graph: Graph = new Map(tasks.map((entry, index) => [entry.id, new Set(tasks.filter((_, target) => target < index && edges[index * 8 + target]).map(({ id: value }) => value))]));
      const roster: readonly Person[] = [
        { id: "first", capacity_days_per_week: capacity, windows: [] },
        { id: "second", capacity_days_per_week: 7, windows: [] },
      ];
      const suggestion = suggestSchedule(tasks, graph, roster, now, { horizon_days: 30 });
      assert.deepEqual(checkSchedule(tasks, graph, roster, now, { assignments: suggestion.assignments, horizon_days: 30 }).violations, []);
      const ordered = [...suggestion.assignments].sort((a, b) => a.task_id < b.task_id ? -1 : 1);
      const again = suggestSchedule([...tasks].reverse(), new Map([...graph].reverse()), [...roster].reverse(), now, { horizon_days: 30 });
      assert.deepEqual([...again.assignments].sort((a, b) => a.task_id < b.task_id ? -1 : 1), ordered);
    },
  ), { numRuns: 500, seed: 73 });
});

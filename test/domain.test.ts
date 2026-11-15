import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { addDep, checkGraph, criticalPath, rank } from "../src/domain/graph.ts";
import { parseMetrics, parseSimulation } from "../src/domain/process-input.ts";
import { parseStatusChange } from "../src/domain/lifecycle.ts";
import { processMetrics, simulate, type ProcessEvent } from "../src/domain/process.ts";
import { isTaskId, type Graph, type Task, type TaskId } from "../src/domain/types.ts";

const id = (value: string): TaskId => {
  assert(isTaskId(value));
  return value;
};
const task = (value: string, patch: Partial<Task> = {}): Task => ({
  id: id(value), list: "default", title: value, status: "todo", priority: 2, estimate_days: 1,
  due: null, assignee: null, labels: [], done_when: null, notes: null,
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", ...patch,
});
const graphOf = (entries: readonly (readonly [string, readonly string[]])[]): Graph =>
  new Map(entries.map(([key, dependencies]) => [id(key), new Set(dependencies.map(id))]));

const acyclic = (graph: Graph): boolean => {
  const nodes = [...new Set([...graph.keys(), ...[...graph.values()].flatMap((dependencies) => [...dependencies])])];
  const paths = nodes.map((source) => nodes.map((target) => graph.get(source)?.has(target) ?? false));
  for (let middle = 0; middle < nodes.length; middle += 1) {
    for (let source = 0; source < nodes.length; source += 1) {
      for (let target = 0; target < nodes.length; target += 1) {
        const row = paths[source];
        if (row !== undefined && paths[source]?.[middle] && paths[middle]?.[target]) row[target] = true;
      }
    }
  }
  return paths.every((row, index) => !row[index]);
};

test("dependency insertion agrees with exhaustive reachability for 10000 graphs of up to eight tasks", () => {
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 8 }),
    fc.array(fc.boolean(), { minLength: 64, maxLength: 64 }),
    fc.integer({ min: 0, max: 7 }),
    fc.integer({ min: 0, max: 7 }),
    (size, edges, rawSource, rawTarget) => {
      const nodes = Array.from({ length: size }, (_, index) => id(`task-${index}`));
      const graph: Graph = new Map(nodes.map((source, sourceIndex) => [source, new Set(nodes.filter((_, targetIndex) =>
        sourceIndex < targetIndex && edges[sourceIndex * 8 + targetIndex]))]));
      const source = nodes[rawSource % size];
      const target = nodes[rawTarget % size];
      assert(source !== undefined && target !== undefined);
      const expected = new Map(graph);
      expected.set(source, new Set([...(graph.get(source) ?? []), target]));
      const before = [...graph].map(([node, dependencies]) => [node, [...dependencies]]);
      const result = addDep(graph, source, target);
      assert.equal(result.ok, acyclic(expected));
      assert.deepEqual([...graph].map(([node, dependencies]) => [node, [...dependencies]]), before);
      if (result.ok) assert.deepEqual(result.value, expected);
      else {
        assert.equal(result.error.cycle[0], source);
        assert.equal(result.error.cycle.at(-1), source);
        assert.equal(result.error.cycle[1], target);
      }
    },
  ), { numRuns: 10_000, seed: 41 });
});

test("cycle errors show the closed path and an existing edge is idempotent", () => {
  const graph = graphOf([["a", ["b"]], ["b", ["c"]], ["c", []]]);
  assert.deepEqual(addDep(graph, id("c"), id("a")), { ok: false, error: { code: "E_CYCLE", cycle: ["c", "a", "b", "c"] } });
  assert.deepEqual(addDep(graph, id("a"), id("b")), { ok: true, value: graph });
  assert.equal(checkGraph(graph).ok, true);
  assert.equal(checkGraph(graphOf([["a", ["b"]], ["b", ["a"]]])).ok, false);
});

test("critical path uses summed duration and lexical path ties independent of insertion order", () => {
  const graph = graphOf([["finish", ["b", "a"]], ["b", ["start"]], ["a", ["start"]], ["start", []]]);
  const estimates = new Map([[id("finish"), 1], [id("a"), 2], [id("b"), 2], [id("start"), 3]]);
  assert.deepEqual(criticalPath(graph, estimates), { path: ["start", "a", "finish"], totalDays: 6 });
  assert.deepEqual(criticalPath(new Map([...graph].reverse()), estimates), { path: ["start", "a", "finish"], totalDays: 6 });
  assert.deepEqual(criticalPath(new Map(), new Map()), { path: [], totalDays: 0 });
  assert.throws(() => criticalPath(graphOf([["a", ["a"]]]), new Map()));
});

test("next excludes closed tasks and every open dependency and explains approval labels", () => {
  const tasks = [task("closed", { status: "done" }), task("canceled", { status: "canceled" }), task("ready"), task("blocked"), task("approval", { labels: ["go:owner approval"] })];
  const graph = graphOf([["closed", []], ["canceled", []], ["ready", ["closed"]], ["blocked", ["canceled"]], ["approval", []]]);
  const ranked = rank(tasks, graph, "2026-01-03T00:00:00.000Z");
  assert.deepEqual(new Set(ranked.map(({ id: value }) => value)), new Set(["ready", "approval"]));
  assert(ranked.find(({ id: value }) => value === "approval")?.reasons.includes("needs approval"));
  assert.deepEqual(rank([...tasks].reverse(), graph, "2026-01-03T00:00:00.000Z"), ranked);
});

test("next sorts by critical path then due date priority estimate and identifier", () => {
  const tasks = [
    task("critical", { priority: 3, estimate_days: 10 }),
    task("due", { due: "2026-01-02T00:00:00.000Z", priority: 3 }),
    task("priority", { priority: 0 }),
    task("small", { estimate_days: 0.5 }),
    task("a"), task("b"), task("unknown", { estimate_days: null }),
  ];
  const graph = new Map(tasks.map((entry) => [entry.id, new Set<TaskId>()]));
  const ranked = rank(tasks, graph, "2026-01-03T00:00:00.000Z");
  assert.deepEqual(ranked.map(({ id: value }) => value), ["critical", "due", "priority", "small", "a", "b", "unknown"]);
  assert(ranked[1]?.reasons.includes("due 2026-01-02T00:00:00.000Z (overdue)"));
});

test("done is terminal except for an explicit reopen to todo", () => {
  for (const status of ["todo", "blocked", "in_progress", "waiting", "canceled"] as const) {
    assert.equal(parseStatusChange("done", status).ok, false);
  }
  assert.deepEqual(parseStatusChange("done", "todo", true), { ok: true, value: { kind: "reopen", from: "done", to: "todo" } });
  assert.equal(parseStatusChange("done", "blocked", true).ok, false);
  assert.equal(parseStatusChange("todo", "todo", true).ok, false);
  assert.deepEqual(parseStatusChange("todo", "todo"), { ok: true, value: null });
});

test("process metrics report observed waits completion cycle and bottleneck with bounded time windows", () => {
  const tasks = [task("work", { status: "done" })];
  const events: readonly ProcessEvent[] = [
    { seq: 1, task_id: id("work"), at: "2026-01-01T00:00:00.000Z", status: "todo" },
    { seq: 2, task_id: id("work"), at: "2026-01-03T00:00:00.000Z", status: "in_progress" },
    { seq: 3, task_id: id("work"), at: "2026-01-04T00:00:00.000Z", status: "waiting" },
    { seq: 4, task_id: id("work"), at: "2026-01-06T00:00:00.000Z", status: "done" },
  ];
  const metrics = processMetrics(tasks, events, "2026-01-08T00:00:00.000Z", { from: "2026-01-02T00:00:00.000Z", to: "2026-01-07T00:00:00.000Z" });
  assert.deepEqual(metrics.cycle_time_days, { p50: 3, p90: 3, samples: 1 });
  assert.deepEqual(metrics.throughput, { completed: 1, days: 5, tasks_per_day: 0.2 });
  assert.equal(metrics.status_wait_days.find(({ status }) => status === "todo")?.total_days, 1);
  assert.equal(metrics.bottlenecks[0]?.status, "waiting");
  assert.equal(metrics.bottlenecks[0]?.total_days, 2);
  assert.equal(processMetrics(tasks, events, "2026-01-08T00:00:00.000Z", { list: "absent" }).throughput.completed, 0);
});

test("simulation respects dependencies capacity and WIP with repeatable sampled durations", () => {
  const tasks = [task("a"), task("b"), task("c")];
  const graph = graphOf([["a", []], ["b", []], ["c", ["a"]]]);
  const input = { scenarios: [{ name: "base" }, { name: "faster", capacity_change: 1 }, { name: "parallel", wip_limit: 2 }], runs: 1000 };
  const result = simulate(tasks, graph, "2026-01-01T00:00:00.000Z", { next: () => 0.5 }, input);
  assert.deepEqual(result.scenarios.map((scenario) => scenario.duration_days.p50), [3, 1.5, 2]);
  assert.deepEqual(simulate(tasks, graph, "2026-01-01T00:00:00.000Z", { next: () => 0.5 }, input), result);
  const blocked = simulate([task("a", { status: "canceled" }), task("b")], graphOf([["a", []], ["b", ["a"]]]), "2026-01-01T00:00:00.000Z", { next: () => 0.5 }, { scenarios: [{ name: "base" }], runs: 1 });
  assert.deepEqual(blocked.scenarios[0]?.blocked, ["b"]);
  assert.equal(blocked.scenarios[0]?.finish.p50, null);
});


test("analysis parsers bound simulation work and reject reversed or ambiguous metric times", () => {
  assert.deepEqual(parseSimulation({ scenarios: [{ name: "base" }] }), { scenarios: [{ name: "base" }], runs: 1000 });
  assert.throws(() => parseMetrics({ from: "2026-01-02T00:00:00Z", to: "2026-01-01T00:00:00Z" }));
  assert.throws(() => parseMetrics({ from: "2026-01-01" }));
  assert.throws(() => parseMetrics({ extra: "ignored" }));
  for (const invalid of [
    { scenarios: [] },
    { scenarios: [{ name: "base" }, { name: "base" }] },
    { scenarios: [{ name: "base", capacity_change: -1 }] },
    { scenarios: [{ name: "base", capacity_change: Infinity }] },
    { scenarios: [{ name: "base", wip_limit: 0 }] },
    { scenarios: [{ name: "base" }], runs: 0 },
    { scenarios: [{ name: "base" }], runs: 10001 },
  ]) assert.throws(() => parseSimulation(invalid));
});

test("every ranked task has all prerequisites done across generated task states", () => {
  fc.assert(fc.property(
    fc.array(fc.constantFrom("todo", "in_progress", "blocked", "waiting", "done", "canceled"), { minLength: 8, maxLength: 8 }),
    fc.array(fc.boolean(), { minLength: 64, maxLength: 64 }),
    (statuses, edges) => {
      const tasks = statuses.map((status, index) => {
        assert(status === "todo" || status === "in_progress" || status === "blocked" || status === "waiting" || status === "done" || status === "canceled");
        return task(`task-${index}`, { status });
      });
      const graph: Graph = new Map(tasks.map((entry, index) => [entry.id, new Set(tasks.filter((_, target) => target < index && edges[index * 8 + target]).map(({ id: value }) => value))]));
      const byId = new Map(tasks.map((entry) => [entry.id, entry]));
      const ranked = rank(tasks, graph, "2026-01-01T00:00:00.000Z");
      for (const entry of ranked) {
        assert(byId.get(entry.id)?.status !== "done" && byId.get(entry.id)?.status !== "canceled");
        for (const dependency of graph.get(entry.id) ?? []) assert.equal(byId.get(dependency)?.status, "done");
      }
    },
  ), { numRuns: 1000, seed: 97 });
});

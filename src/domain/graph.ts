import { failure } from "@ambitious/kit/domain/failure";
import {
  err,
  ok,
  type AddDep,
  type CriticalPath,
  type CycleError,
  type Graph,
  type Rank,
  type Result,
  type TaskId,
} from "./types.ts";

const compareIds = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const pathBetween = (graph: Graph, start: TaskId, target: TaskId): readonly TaskId[] | null => {
  const parents = new Map<TaskId, TaskId | null>([[start, null]]);
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current === target) {
      const path: TaskId[] = [];
      let step: TaskId | null | undefined = current;
      while (step !== null && step !== undefined) {
        path.push(step);
        step = parents.get(step);
      }
      return path.reverse();
    }
    for (const successor of [...(graph.get(current) ?? [])].sort(compareIds).reverse()) {
      if (parents.has(successor)) continue;
      parents.set(successor, current);
      pending.push(successor);
    }
  }
  return null;
};

export const addDep: AddDep = (graph, task, dependsOn) => {
  const path = pathBetween(graph, dependsOn, task);
  if (path !== null) return err({ code: "E_CYCLE", cycle: [task, ...path] });
  const result = new Map(graph);
  result.set(task, new Set([...(graph.get(task) ?? []), dependsOn]));
  if (!result.has(dependsOn)) result.set(dependsOn, new Set());
  return ok(result);
};

export const checkGraph = (graph: Graph): Result<Graph, CycleError> => {
  let checked: Graph = new Map([...graph.keys()].map((id) => [id, new Set<TaskId>()]));
  for (const task of [...graph.keys()].sort(compareIds)) {
    for (const dependency of [...(graph.get(task) ?? [])].sort(compareIds)) {
      const added = addDep(checked, task, dependency);
      if (!added.ok) return added;
      checked = added.value;
    }
  }
  return ok(graph);
};

const comparePaths = (left: readonly TaskId[], right: readonly TaskId[]): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a !== undefined && b !== undefined && a !== b) return compareIds(a, b);
  }
  return left.length - right.length;
};

type Path = ReturnType<CriticalPath>;

const betterPath = (left: Path, right: Path): Path =>
  left.totalDays > right.totalDays ||
  (left.totalDays === right.totalDays && comparePaths(left.path, right.path) < 0) ? left : right;

export const criticalPath: CriticalPath = (graph, estimateDays) => {
  const nodes = new Set([...graph.keys(), ...[...graph.values()].flatMap((deps) => [...deps])]);
  const remaining = new Map<TaskId, number>();
  const dependents = new Map<TaskId, TaskId[]>();
  const paths = new Map<TaskId, Path>();
  const pending: TaskId[] = [];
  for (const node of nodes) {
    const deps = graph.get(node) ?? new Set<TaskId>();
    remaining.set(node, deps.size);
    if (deps.size === 0) pending.push(node);
    for (const dependency of deps) {
      const successors = dependents.get(dependency) ?? [];
      successors.push(node);
      dependents.set(dependency, successors);
    }
  }
  let best: Path = { path: [], totalDays: 0 };
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    let prerequisitePath: Path = { path: [], totalDays: 0 };
    for (const dependency of graph.get(node) ?? []) {
      const candidate = paths.get(dependency);
      if (candidate !== undefined) prerequisitePath = betterPath(candidate, prerequisitePath);
    }
    const path: Path = {
      path: [...prerequisitePath.path, node],
      totalDays: prerequisitePath.totalDays + (estimateDays.get(node) ?? 0),
    };
    if (!Number.isFinite(path.totalDays)) {
      throw failure("E_RANGE", "The critical path estimate exceeds the supported numeric range.", "Reduce the task estimates before requesting the graph or ranking.");
    }
    paths.set(node, path);
    best = best.path.length === 0 ? path : betterPath(path, best);
    for (const dependent of dependents.get(node) ?? []) {
      const count = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, count);
      if (count === 0) pending.push(dependent);
    }
  }
  if (paths.size !== nodes.size) throw new Error("Critical path requires an acyclic graph.");
  return best;
};

export const rank: Rank = (tasks, graph, now) => {
  const statuses = new Map(tasks.map((task) => [task.id, task.status]));
  const open = tasks.filter((task) => task.status !== "done" && task.status !== "canceled");
  const openIds = new Set(open.map((task) => task.id));
  const remainingGraph: Graph = new Map(open.map((task) => [
    task.id,
    new Set([...(graph.get(task.id) ?? [])].filter((id) => openIds.has(id))),
  ]));
  const estimates = new Map(open.map((task) => [task.id, task.estimate_days ?? 0]));
  const critical = new Set(criticalPath(remainingGraph, estimates).path);
  const ready = open.filter((task) => [...(graph.get(task.id) ?? [])].every((id) => statuses.get(id) === "done"));
  ready.sort((left, right) => {
    const pathOrder = Number(critical.has(right.id)) - Number(critical.has(left.id));
    if (pathOrder !== 0) return pathOrder;
    const dueOrder = (left.due === null ? Infinity : Date.parse(left.due)) -
      (right.due === null ? Infinity : Date.parse(right.due));
    if (!Number.isNaN(dueOrder) && dueOrder !== 0) return dueOrder;
    if (left.priority !== right.priority) return left.priority - right.priority;
    const estimateOrder = (left.estimate_days ?? Infinity) - (right.estimate_days ?? Infinity);
    if (!Number.isNaN(estimateOrder) && estimateOrder !== 0) return estimateOrder;
    return compareIds(left.id, right.id);
  });
  return ready.map((task, index) => ({
    id: task.id,
    title: task.title,
    score: ready.length - index,
    reasons: [
      "all dependencies done",
      critical.has(task.id) ? "on critical path" : "outside critical path",
      task.due === null ? "no due date" : `due ${task.due}${Date.parse(task.due) < Date.parse(now) ? " (overdue)" : ""}`,
      `priority ${task.priority}`,
      task.estimate_days === null ? "no estimate" : `estimate ${task.estimate_days} days`,
      `id ${task.id}`,
      ...task.labels.filter((label) => label.startsWith("go:")).flatMap((label) => ["needs approval", label.slice(3)]),
    ],
  }));
};

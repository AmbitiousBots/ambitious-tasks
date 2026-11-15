import { failure } from "@ambitious/kit/domain/failure";
import { criticalPath, rank } from "./graph.ts";
import { CLOSED_STATUSES, OPEN_STATUSES, type Graph, type Task, type TaskId } from "./types.ts";

export const nextTasks = (
  tasks: readonly Task[], graph: Graph, now: string, input: { readonly list?: string; readonly assignee?: string; readonly limit?: number },
) => {
  const matching = new Set(tasks.filter((task) =>
    (input.list === undefined || input.list === task.list) &&
    (input.assignee === undefined || input.assignee === task.assignee)).map(({ id }) => id));
  return { ranked: rank(tasks, graph, now).filter(({ id }) => matching.has(id)).slice(0, input.limit ?? 10) };
};

export const graphView = (tasks: readonly Task[], graph: Graph, list?: string) => {
  const nodes = tasks.filter((task) => list === undefined || task.list === list);
  const closure = new Set(nodes.map(({ id }) => id));
  const pending = [...closure];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined) break;
    for (const dep of graph.get(id) ?? []) {
      if (!closure.has(dep)) {
        closure.add(dep);
        pending.push(dep);
      }
    }
  }
  const included: Graph = new Map([...closure].map((id) => [id, graph.get(id) ?? new Set<TaskId>()]));
  const path = criticalPath(included, new Map(tasks.map((task) => [task.id, task.estimate_days ?? 0])));
  const totalDays = nodes.reduce((sum, task) => sum + (task.estimate_days ?? 0), 0);
  if (!Number.isFinite(totalDays)) {
    throw failure("E_RANGE", "The total effort exceeds the supported numeric range.", "Reduce task estimates or select a smaller list.");
  }
  return {
    nodes,
    edges: nodes.flatMap((task) => [...(graph.get(task.id) ?? [])].sort().map((depends_on) => ({ task_id: task.id, depends_on }))),
    critical_path: path.path,
    critical_path_days: path.totalDays,
    total_days: totalDays,
  };
};

export const boardView = (tasks: readonly Task[]) => ({
  columns: [...OPEN_STATUSES, ...CLOSED_STATUSES].map((status) => ({ status, tasks: tasks.filter((task) => task.status === status) })),
});

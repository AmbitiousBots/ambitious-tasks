import { failure } from "@ambitious/kit/domain/failure";
import { checkGraph } from "./graph.ts";
import { parseStatusChange } from "./lifecycle.ts";
import type { ImportInput, TaskPatch } from "./requests.ts";
import type { Graph, Task, TaskId } from "./types.ts";

export const newTask = (input: TaskPatch & { readonly title: string }, id: TaskId, now: string): Task => ({
  id,
  list: input.list ?? "default",
  title: input.title,
  status: "todo",
  priority: input.priority ?? 2,
  estimate_days: input.estimate_days ?? null,
  due: input.due ?? null,
  assignee: input.assignee ?? null,
  labels: input.labels ?? [],
  done_when: input.done_when ?? null,
  notes: input.notes ?? null,
  created_at: now,
  updated_at: now,
});

export const validateGraph = (graph: Graph): void => {
  for (const deps of graph.values()) {
    for (const dependency of deps) {
      if (!graph.has(dependency)) {
        throw failure("E_UNKNOWN_DEP", `Dependency ${dependency} does not exist.`, "Add the prerequisite or include it in the same import.");
      }
    }
  }
  const checked = checkGraph(graph);
  if (!checked.ok) {
    throw failure("E_CYCLE", "These dependencies would form a cycle.", "Remove one of the dependencies in data.cycle and try again.", { cycle: checked.error.cycle });
  }
};

export const sameTask = (a: Task, b: Task): boolean => JSON.stringify({ ...a, updated_at: "" }) === JSON.stringify({ ...b, updated_at: "" });

export const validateTransition = (from: Task["status"], to: Task["status"], reopen = false): void => {
  const transition = parseStatusChange(from, to, reopen);
  if (!transition.ok) throw failure(transition.error.code, transition.error.message, 'Use status with {"status":"todo","reopen":true} to reopen a done task.');
};

export const validateEventTime = (previous: string | undefined, now: string): void => {
  if (previous !== undefined && now < previous) {
    throw failure("E_TIME", "The event time precedes this task's last recorded change.", "Use --now at or after the last event timestamp shown by history.");
  }
};

export const planImport = (tasks: readonly Task[], dependencies: Graph, input: ImportInput, now: string) => {
  const existing = new Map(tasks.map((task) => [task.id, task]));
  const graph = new Map(dependencies);
  const changes: { readonly task: Task; readonly depends_on: readonly TaskId[]; readonly created: boolean }[] = [];
  let unchanged = 0;
  for (const entry of input.tasks) {
    const before = existing.get(entry.id);
    const { depends_on: requestedDependencies, status, ...fields } = entry;
    const dependsOn = requestedDependencies ?? [...(dependencies.get(entry.id) ?? [])].sort();
    const task: Task = before === undefined
      ? { ...newTask(fields, entry.id, now), status: status ?? "todo" }
      : { ...before, ...fields, status: status ?? before.status, updated_at: now };
    if (before !== undefined) validateTransition(before.status, task.status);
    const previousDependencies = [...(graph.get(entry.id) ?? [])].sort();
    graph.set(entry.id, new Set(dependsOn));
    if (before !== undefined && sameTask(before, task) && JSON.stringify(previousDependencies) === JSON.stringify(dependsOn)) unchanged += 1;
    else changes.push({ task, depends_on: dependsOn, created: before === undefined });
  }
  validateGraph(graph);
  return { changes, unchanged };
};

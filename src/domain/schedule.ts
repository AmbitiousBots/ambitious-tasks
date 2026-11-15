import { rank } from "./graph.ts";
import type { Graph, Task, TaskId } from "./types.ts";

export type Window = { readonly start: string; readonly end: string };
export type Person = {
  readonly id: string;
  readonly name?: string;
  readonly capacity_days_per_week: number;
  readonly windows: readonly Window[];
};
export type Assignment = {
  readonly task_id: TaskId;
  readonly person_id: string;
  readonly start: string;
  readonly end: string;
};
export type SuggestInput = {
  readonly list?: string;
  readonly people?: readonly Person[];
  readonly horizon_days: number;
};
export type CheckInput = {
  readonly assignments: readonly Assignment[];
  readonly people?: readonly Person[];
  readonly horizon_days?: number;
};
export type Violation = {
  readonly code: string;
  readonly message: string;
  readonly task_id?: TaskId;
  readonly person_id?: string;
};

const DAY = 86_400_000;
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const open = (task: Task): boolean => task.status !== "done" && task.status !== "canceled";
const length = (task: Task, person: Person): number =>
  Math.ceil((task.estimate_days ?? 1) * 7 * DAY / person.capacity_days_per_week);

export const checkSchedule = (
  tasks: readonly Task[],
  graph: Graph,
  storedPeople: readonly Person[],
  now: string,
  input: CheckInput,
): { readonly violations: readonly Violation[] } => {
  const people = new Map((input.people ?? storedPeople).map((person) => [person.id, person]));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const violations: Violation[] = [];
  const scheduled = new Map<TaskId, Assignment>();
  const beginning = Date.parse(now);
  const horizon = input.horizon_days === undefined ? Infinity : beginning + input.horizon_days * DAY;
  for (const assignment of input.assignments) {
    const task = byId.get(assignment.task_id);
    const person = people.get(assignment.person_id);
    const start = Date.parse(assignment.start);
    const end = Date.parse(assignment.end);
    const report = (code: string, message: string): void => {
      violations.push({ code, message, task_id: assignment.task_id, person_id: assignment.person_id });
    };
    if (scheduled.has(assignment.task_id)) report("DUPLICATE_TASK", "A task has more than one assignment.");
    else scheduled.set(assignment.task_id, assignment);
    if (task === undefined) report("UNKNOWN_TASK", "The assigned task does not exist.");
    if (person === undefined) report("UNKNOWN_PERSON", "The assigned person does not exist in the roster.");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      report("INVALID_INTERVAL", "The assignment needs valid timestamps with its end at or after its start.");
      continue;
    }
    if (start < beginning || end > horizon) report("OUTSIDE_HORIZON", "The assignment falls outside the requested planning horizon.");
    if (person !== undefined && person.windows.length > 0 && !person.windows.some((window) =>
      Date.parse(window.start) <= start && Date.parse(window.end) >= end)) {
      report("OUTSIDE_WINDOW", "The assignment does not fit within one of the person's availability windows.");
    }
    if (task !== undefined) {
      if (!open(task)) report("CLOSED_TASK", "A done or canceled task must not be scheduled.");
      if (task.assignee !== null && task.assignee !== assignment.person_id) {
        report("ASSIGNEE_MISMATCH", "The assignment does not match the task's current assignee.");
      }
      if (person !== undefined) {
        if (person.capacity_days_per_week <= 0) report("NO_CAPACITY", "The person has no available capacity.");
        else {
          const required = (task.estimate_days ?? 1) * 7 * DAY / person.capacity_days_per_week;
          if (end - start < required) report("CAPACITY_EXCEEDED", "The interval is too short for the estimated effort at this person's capacity.");
          if (end - start > Math.ceil(required)) report("DURATION_MISMATCH", "The interval is longer than the estimated effort at this person's capacity.");
        }
      }
    }
  }
  for (const assignment of input.assignments) {
    for (const dependency of graph.get(assignment.task_id) ?? []) {
      if (byId.get(dependency)?.status === "done") continue;
      const prerequisite = scheduled.get(dependency);
      if (prerequisite === undefined || Date.parse(prerequisite.end) > Date.parse(assignment.start)) {
        violations.push({ code: "DEPENDENCY_OPEN", message: "A prerequisite is neither done nor scheduled to finish before this task starts.", task_id: assignment.task_id });
      }
    }
  }
  for (const person of people.values()) {
    const intervals = input.assignments.filter((assignment) => assignment.person_id === person.id)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || compareText(a.task_id, b.task_id));
    let latestEnd = -Infinity;
    for (const assignment of intervals) {
      const start = Date.parse(assignment.start);
      const end = Date.parse(assignment.end);
      if (end > start && start < latestEnd) {
        violations.push({ code: "OVERLAP", message: "The person has overlapping task assignments.", task_id: assignment.task_id, person_id: person.id });
      }
      if (end > start) latestEnd = Math.max(latestEnd, end);
    }
  }
  return { violations };
};

const availableStart = (
  person: Person,
  assignments: readonly Assignment[],
  earliest: number,
  duration: number,
  horizon: number,
): number | null => {
  const windows = person.windows.length === 0 ? [{ start: earliest, end: horizon }] : person.windows
    .map((window) => ({ start: Date.parse(window.start), end: Math.min(horizon, Date.parse(window.end)) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const busy = assignments.filter((assignment) => assignment.person_id === person.id)
    .map((assignment) => ({ start: Date.parse(assignment.start), end: Date.parse(assignment.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (const window of windows) {
    let start = Math.max(earliest, window.start);
    for (const interval of busy) {
      if (start + duration <= interval.start) break;
      if (start < interval.end && start + duration > interval.start) start = interval.end;
    }
    if (start + duration <= window.end) return start;
  }
  return null;
};

export const suggestSchedule = (
  tasks: readonly Task[],
  graph: Graph,
  storedPeople: readonly Person[],
  now: string,
  input: SuggestInput,
): { readonly assignments: readonly Assignment[]; readonly violations: readonly Violation[] } => {
  const people = [...(input.people ?? storedPeople)].sort((a, b) => compareText(a.id, b.id));
  const beginning = Date.parse(now);
  const horizon = beginning + input.horizon_days * DAY;
  const assignments: Assignment[] = [];
  const violations: Violation[] = [];
  const pending = new Map(tasks.filter((task) => open(task) && (input.list === undefined || task.list === input.list))
    .map((task) => [task.id, task]));
  const completed = new Map(tasks.filter((task) => task.status === "done").map((task) => [task.id, beginning]));
  while (pending.size > 0) {
    const ready = rank(tasks.map((task) => completed.has(task.id) ? { ...task, status: "done" as const } : task), graph, now)
      .filter(({ id }) => pending.has(id));
    if (ready.length === 0) break;
    for (const { id } of ready) {
      const task = pending.get(id);
      if (task === undefined) continue;
      pending.delete(id);
      let earliest = beginning;
      for (const prerequisite of graph.get(id) ?? []) earliest = Math.max(earliest, completed.get(prerequisite) ?? Infinity);
      const choices = people.filter((person) => person.capacity_days_per_week > 0 && (task.assignee === null || person.id === task.assignee))
        .map((person) => {
          const duration = length(task, person);
          const start = availableStart(person, assignments, earliest, duration, horizon);
          return { person, start, end: start === null ? Infinity : start + duration };
        }).filter((choice) => choice.start !== null)
        .sort((a, b) => a.end - b.end || (a.start ?? Infinity) - (b.start ?? Infinity) || compareText(a.person.id, b.person.id));
      const choice = choices[0];
      if (choice === undefined || choice.start === null || !Number.isFinite(choice.end)) {
        violations.push({ code: "NO_FEASIBLE_SLOT", message: "No person has enough capacity and an availability window within the horizon for this task.", task_id: id });
        continue;
      }
      assignments.push({ task_id: id, person_id: choice.person.id, start: new Date(choice.start).toISOString(), end: new Date(choice.end).toISOString() });
      completed.set(id, choice.end);
    }
  }
  for (const id of [...pending.keys()].sort(compareText)) {
    violations.push({ code: "DEPENDENCY_OPEN", message: "A prerequisite could not be scheduled or is outside the selected list.", task_id: id });
  }
  return { assignments, violations: [...violations, ...checkSchedule(tasks, graph, storedPeople, now, { assignments, people, horizon_days: input.horizon_days }).violations] };
};

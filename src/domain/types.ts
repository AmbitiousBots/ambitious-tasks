declare const taskIdBrand: unique symbol;

export type TaskId = string & { readonly [taskIdBrand]: true };

export const isTaskId = (raw: string): raw is TaskId => raw.length > 0 && raw.trim() === raw;

export const DEFAULT_LIST = "default";

export const OPEN_STATUSES = ["todo", "in_progress", "blocked", "waiting"] as const;
export const CLOSED_STATUSES = ["done", "canceled"] as const;

export type OpenStatus = (typeof OPEN_STATUSES)[number];
export type ClosedStatus = (typeof CLOSED_STATUSES)[number];
export type Status = OpenStatus | ClosedStatus;

type SetFrom = Exclude<Status, "done">;

export type StatusChange =
  | { readonly [From in SetFrom]: { readonly kind: "set"; readonly from: From; readonly to: Exclude<Status, From> } }[SetFrom]
  | { readonly kind: "reopen"; readonly from: "done"; readonly to: "todo" };

export type Priority = 0 | 1 | 2 | 3;

export const EVENT_KINDS = ["created", "updated", "status", "dep_added", "dep_removed", "imported"] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export type Task = {
  readonly id: TaskId;
  readonly list: string;
  readonly title: string;
  readonly status: Status;
  readonly priority: Priority;
  readonly estimate_days: number | null;
  readonly due: string | null;
  readonly assignee: string | null;
  readonly labels: readonly string[];
  readonly done_when: string | null;
  readonly notes: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type Graph = ReadonlyMap<TaskId, ReadonlySet<TaskId>>;

export type CycleError = {
  readonly code: "E_CYCLE";
  readonly cycle: readonly [TaskId, ...TaskId[]];
};

export type RankedTask = Task & {
  readonly score: number;
  readonly reasons: readonly string[];
};

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export type AddDep = (graph: Graph, task: TaskId, dependsOn: TaskId) => Result<Graph, CycleError>;

export type CriticalPath = (
  graph: Graph,
  estimateDays: ReadonlyMap<TaskId, number>,
) => { readonly path: readonly TaskId[]; readonly totalDays: number };

export type Rank = (tasks: readonly Task[], graph: Graph, now: string) => readonly RankedTask[];

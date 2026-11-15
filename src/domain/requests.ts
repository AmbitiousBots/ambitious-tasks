import { parseNow } from "@ambitious/kit/domain/clock";
import { failure } from "@ambitious/kit/domain/failure";
import { isRecord } from "@ambitious/kit/domain/json";
import { isTaskId, type Priority, type Status, type TaskId } from "./types.ts";

export const inputError = (message: string): never => {
  throw failure("E_INPUT_SCHEMA", message, "Use the documented fields and value types for this command.");
};

export const objectInput = (raw: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> => {
  if (!isRecord(raw)) return inputError("The input must be a JSON object.");
  const unknown = Object.keys(raw).filter((field) => !fields.includes(field));
  if (unknown.length > 0) return inputError(`Unknown input fields: ${unknown.join(", ")}.`);
  return raw;
};

export const textInput = (raw: unknown, field: string): string => {
  if (typeof raw !== "string" || raw.trim() === "") return inputError(`${field} must be a nonempty string.`);
  return raw;
};

export const idInput = (raw: unknown, field = "id"): TaskId => {
  if (typeof raw !== "string" || !isTaskId(raw)) return inputError(`${field} must be a nonempty string without surrounding spaces.`);
  return raw;
};

export const statusInput = (raw: unknown): Status => {
  if (raw === "todo" || raw === "in_progress" || raw === "blocked" || raw === "waiting" || raw === "done" || raw === "canceled") return raw;
  return inputError("status must be todo, in_progress, blocked, waiting, done or canceled.");
};

const priorityInput = (raw: unknown): Priority => {
  if (raw === 0 || raw === 1 || raw === 2 || raw === 3) return raw;
  return inputError("priority must be a whole number from 0 to 3.");
};

const numberInput = (raw: unknown, field: string): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return inputError(`${field} must be a finite nonnegative number.`);
  return raw;
};

const nullableText = (raw: unknown, field: string): string | null => raw === null ? null : textInput(raw, field);

const dueInput = (raw: unknown): string | null => {
  if (raw === null) return null;
  const text = textInput(raw, "due");
  const instant = parseNow(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text);
  if (instant === null) return inputError("due must be a calendar date or an ISO timestamp with a time zone.");
  return instant.toISOString();
};

const stringList = (raw: unknown, field: string): readonly string[] => {
  if (!Array.isArray(raw)) return inputError(`${field} must be an array of strings.`);
  return [...new Set(raw.map((value: unknown) => textInput(value, field)))].sort();
};

const dependenciesInput = (raw: unknown): readonly TaskId[] => {
  if (!Array.isArray(raw)) return inputError("depends_on must be an array of task ids.");
  return [...new Set(raw.map((value: unknown) => idInput(value, "depends_on")))].sort();
};

export type WriteOptions = { readonly idem_key?: string; readonly actor?: string };

const writeOptions = (raw: Readonly<Record<string, unknown>>): WriteOptions => ({
  ...(raw.idem_key === undefined ? {} : { idem_key: textInput(raw.idem_key, "idem_key") }),
  ...(raw.actor === undefined ? {} : { actor: textInput(raw.actor, "actor") }),
});

export type TaskPatch = {
  readonly title?: string;
  readonly list?: string;
  readonly priority?: Priority;
  readonly estimate_days?: number | null;
  readonly due?: string | null;
  readonly assignee?: string | null;
  readonly labels?: readonly string[];
  readonly done_when?: string | null;
  readonly notes?: string | null;
};

const PATCH_FIELDS = ["title", "list", "priority", "estimate_days", "due", "assignee", "labels", "done_when", "notes"] as const;
const WRITE_FIELDS = ["idem_key", "actor"] as const;

const taskPatch = (raw: Readonly<Record<string, unknown>>): TaskPatch => ({
  ...(raw.title === undefined ? {} : { title: textInput(raw.title, "title") }),
  ...(raw.list === undefined ? {} : { list: textInput(raw.list, "list") }),
  ...(raw.priority === undefined ? {} : { priority: priorityInput(raw.priority) }),
  ...(raw.estimate_days === undefined ? {} : { estimate_days: raw.estimate_days === null ? null : numberInput(raw.estimate_days, "estimate_days") }),
  ...(raw.due === undefined ? {} : { due: dueInput(raw.due) }),
  ...(raw.assignee === undefined ? {} : { assignee: nullableText(raw.assignee, "assignee") }),
  ...(raw.labels === undefined ? {} : { labels: stringList(raw.labels, "labels") }),
  ...(raw.done_when === undefined ? {} : { done_when: nullableText(raw.done_when, "done_when") }),
  ...(raw.notes === undefined ? {} : { notes: nullableText(raw.notes, "notes") }),
});

export type AddInput = TaskPatch & WriteOptions & {
  readonly title: string;
  readonly id?: TaskId;
  readonly depends_on: readonly TaskId[];
};

export const parseAdd = (raw: unknown): AddInput => {
  const input = objectInput(raw, [...PATCH_FIELDS, ...WRITE_FIELDS, "id", "depends_on"]);
  return {
    ...taskPatch(input),
    title: textInput(input.title, "title"),
    ...(input.id === undefined ? {} : { id: idInput(input.id) }),
    depends_on: input.depends_on === undefined ? [] : dependenciesInput(input.depends_on),
    ...writeOptions(input),
  };
};

export type UpdateInput = WriteOptions & { readonly id: TaskId; readonly patch: TaskPatch };

export const parseUpdate = (raw: unknown): UpdateInput => {
  const input = objectInput(raw, ["id", "patch", ...WRITE_FIELDS]);
  return { id: idInput(input.id), patch: taskPatch(objectInput(input.patch, PATCH_FIELDS)), ...writeOptions(input) };
};

export type StatusInput = WriteOptions & {
  readonly id: TaskId;
  readonly status: Status;
  readonly reopen: boolean;
  readonly note?: string;
};

export const parseStatus = (raw: unknown): StatusInput => {
  const input = objectInput(raw, ["id", "status", "reopen", "note", ...WRITE_FIELDS]);
  if (input.reopen !== undefined && typeof input.reopen !== "boolean") return inputError("reopen must be true or false.");
  return {
    id: idInput(input.id), status: statusInput(input.status), reopen: input.reopen ?? false,
    ...(input.note === undefined ? {} : { note: textInput(input.note, "note") }),
    ...writeOptions(input),
  };
};

export type DepInput = WriteOptions & { readonly task_id: TaskId; readonly depends_on: TaskId };

export const parseDep = (raw: unknown): DepInput => {
  const input = objectInput(raw, ["task_id", "depends_on", ...WRITE_FIELDS]);
  return { task_id: idInput(input.task_id, "task_id"), depends_on: idInput(input.depends_on, "depends_on"), ...writeOptions(input) };
};

export type IdInput = { readonly id: TaskId };

export const parseId = (raw: unknown): IdInput => {
  const input = objectInput(raw, ["id"]);
  return { id: idInput(input.id) };
};

export type FilterInput = { readonly list?: string; readonly status?: Status; readonly label?: string; readonly assignee?: string };

export const parseFilter = (raw: unknown): FilterInput => {
  const input = objectInput(raw, ["list", "status", "label", "assignee"]);
  return {
    ...(input.list === undefined ? {} : { list: textInput(input.list, "list") }),
    ...(input.status === undefined ? {} : { status: statusInput(input.status) }),
    ...(input.label === undefined ? {} : { label: textInput(input.label, "label") }),
    ...(input.assignee === undefined ? {} : { assignee: textInput(input.assignee, "assignee") }),
  };
};

export const parseListScope = (raw: unknown): { readonly list?: string } => {
  const input = objectInput(raw, ["list"]);
  return input.list === undefined ? {} : { list: textInput(input.list, "list") };
};

export type CountsInput = { readonly list: string };

export const parseCounts = (raw: unknown): CountsInput => {
  const input = objectInput(raw, ["list"]);
  return { list: textInput(input.list, "list") };
};

export type NextInput = { readonly list?: string; readonly assignee?: string; readonly limit: number };

export const parseNext = (raw: unknown): NextInput => {
  const input = objectInput(raw, ["list", "limit", "assignee"]);
  const limit = input.limit === undefined ? 10 : numberInput(input.limit, "limit");
  if (!Number.isSafeInteger(limit)) return inputError("limit must be a nonnegative safe integer.");
  return {
    ...(input.list === undefined ? {} : { list: textInput(input.list, "list") }),
    ...(input.assignee === undefined ? {} : { assignee: textInput(input.assignee, "assignee") }),
    limit,
  };
};

export type ImportedTask = TaskPatch & {
  readonly id: TaskId;
  readonly title: string;
  readonly depends_on?: readonly TaskId[];
  readonly status?: Status;
};

export type ImportInput = WriteOptions & { readonly schemaVersion: 1 | 2; readonly tasks: readonly ImportedTask[] };

export const parseImport = (raw: unknown): ImportInput => {
  const input = objectInput(raw, ["schemaVersion", "tasks", "source", "estimateUnit", ...WRITE_FIELDS]);
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2) return inputError("schemaVersion must be 1 or 2.");
  if (!Array.isArray(input.tasks)) return inputError("tasks must be an array.");
  const tasks = input.tasks.map((rawTask: unknown): ImportedTask => {
    const task = objectInput(rawTask, [...PATCH_FIELDS, "id", "phase", "depends_on", "status", "needs_go_ahead"]);
    const labels = task.labels === undefined ? [] : stringList(task.labels, "labels");
    const approval = task.needs_go_ahead === undefined ? [] : [`go:${textInput(task.needs_go_ahead, "needs_go_ahead")}`];
    if (task.phase !== undefined && task.list !== undefined && task.phase !== task.list) return inputError("phase and list must agree when both are present.");
    return {
      ...taskPatch(task),
      id: idInput(task.id),
      title: textInput(task.title, "title"),
      ...(task.list === undefined && task.phase === undefined ? {} : { list: textInput(task.list ?? task.phase, "list") }),
      ...(task.status === undefined ? {} : { status: statusInput(task.status) }),
      ...(task.labels === undefined && task.needs_go_ahead === undefined ? {} : { labels: [...new Set([...labels, ...approval])].sort() }),
      ...(task.depends_on === undefined ? {} : { depends_on: dependenciesInput(task.depends_on) }),
    };
  });
  if (new Set(tasks.map(({ id }) => id)).size !== tasks.length) return inputError("An import must contain each task id only once.");
  return { schemaVersion: input.schemaVersion, tasks: [...tasks].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), ...writeOptions(input) };
};

export const parseEmpty = (raw: unknown): Record<string, never> => {
  objectInput(raw, []);
  return {};
};

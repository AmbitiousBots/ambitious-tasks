import type { Rng } from "@ambitious/kit/domain/clock";
import { failure } from "@ambitious/kit/domain/failure";
import { isRecord, type JsonObject, type JsonValue } from "@ambitious/kit/domain/json";
import type { Db } from "@ambitious/kit/db/open-db";
import { addDep } from "../domain/graph.ts";
import { newTask, planImport, sameTask, validateEventTime, validateGraph, validateTransition } from "../domain/task-state.ts";
import type { ProcessEvent } from "../domain/process.ts";
import {
  idInput,
  parseAdd,
  statusInput,
  textInput,
  type AddInput,
  type DepInput,
  type FilterInput,
  type ImportInput,
  type StatusInput,
  type UpdateInput,
  type WriteOptions,
} from "../domain/requests.ts";
import { parsePeople } from "../domain/schedule-input.ts";
import { EVENT_KINDS, type EventKind, type Graph, type Task, type TaskId } from "../domain/types.ts";

export type TaskView = Task & { readonly depends_on: readonly TaskId[] };
export type TaskEvent = {
  readonly seq: number;
  readonly at: string;
  readonly actor: string;
  readonly kind: EventKind;
  readonly task_id: TaskId;
  readonly payload: JsonObject;
  readonly idem_key: string | null;
};

type Snapshot = { readonly task: Task; readonly depends_on: readonly TaskId[] };

const databaseError = (): never => {
  throw failure("E_DB", "Stored task data does not match the database schema.", "Run selfcheck and restore a valid database backup if needed.");
};

const json = (text: unknown): unknown => {
  if (typeof text !== "string") return databaseError();
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return databaseError();
  }
};

const isJson = (raw: unknown): raw is JsonValue => {
  if (raw === null || typeof raw === "string" || typeof raw === "boolean") return true;
  if (typeof raw === "number") return Number.isFinite(raw);
  if (Array.isArray(raw)) return raw.every((item: unknown) => isJson(item));
  return isRecord(raw) && Object.values(raw).every(isJson);
};

const jsonObject = (raw: unknown): JsonObject => {
  if (!isRecord(raw) || !isJson(raw)) return databaseError();
  return raw;
};

const storedTask = (raw: unknown): Task => {
  try {
    if (!isRecord(raw)) return databaseError();
    const parsed = parseAdd({
      id: raw.id,
      list: raw.list,
      title: raw.title,
      priority: raw.priority,
      estimate_days: raw.estimate_days,
      due: raw.due,
      assignee: raw.assignee,
      labels: raw.labels,
      done_when: raw.done_when,
      notes: raw.notes,
    });
    const id = idInput(raw.id);
    return {
      ...newTask(parsed, id, textInput(raw.created_at, "created_at")),
      status: statusInput(raw.status),
      updated_at: textInput(raw.updated_at, "updated_at"),
    };
  } catch {
    return databaseError();
  }
};

const taskRow = (row: Readonly<Record<string, unknown>>): Task => storedTask({ ...row, labels: json(row.labels) });

export const listTasks = (db: Db, filter: FilterInput = {}): readonly Task[] => db
  .prepare("SELECT * FROM tasks ORDER BY id").all().map(taskRow)
  .filter((task) => (filter.list === undefined || task.list === filter.list) &&
    (filter.status === undefined || task.status === filter.status) &&
    (filter.label === undefined || task.labels.includes(filter.label)) &&
    (filter.assignee === undefined || task.assignee === filter.assignee));

const findTask = (db: Db, id: TaskId): Task | undefined => {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
  return row === undefined ? undefined : taskRow(row);
};

export const getTask = (db: Db, id: TaskId): Task => {
  const task = findTask(db, id);
  if (task === undefined) throw failure("E_NOT_FOUND", `Task ${id} does not exist.`, "Use list to find a task id, or add the task first.");
  return task;
};

const dependencyIds = (db: Db, id: TaskId): readonly TaskId[] => db
  .prepare("SELECT depends_on FROM deps WHERE task_id = ? ORDER BY depends_on").all(id)
  .map((row) => idInput(row.depends_on, "depends_on"));

export const taskWithDependencies = (db: Db, task: Task): TaskView => ({ ...task, depends_on: dependencyIds(db, task.id) });

export const loadGraph = (db: Db): Graph => {
  const graph = new Map<TaskId, Set<TaskId>>(listTasks(db).map(({ id }) => [id, new Set<TaskId>()]));
  for (const row of db.prepare("SELECT task_id, depends_on FROM deps ORDER BY task_id, depends_on").all()) {
    const task = idInput(row.task_id, "task_id");
    const dependency = idInput(row.depends_on, "depends_on");
    const deps = graph.get(task);
    if (deps === undefined || !graph.has(dependency)) return databaseError();
    deps.add(dependency);
  }
  return graph;
};

const putTask = (db: Db, task: Task): void => {
  db.prepare(`INSERT INTO tasks (id, list, title, status, priority, estimate_days, due, assignee, labels, done_when, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET list=excluded.list, title=excluded.title, status=excluded.status,
    priority=excluded.priority, estimate_days=excluded.estimate_days, due=excluded.due, assignee=excluded.assignee,
    labels=excluded.labels, done_when=excluded.done_when, notes=excluded.notes, created_at=excluded.created_at, updated_at=excluded.updated_at`)
    .run(task.id, task.list, task.title, task.status, task.priority, task.estimate_days, task.due, task.assignee,
      JSON.stringify(task.labels), task.done_when, task.notes, task.created_at, task.updated_at);
};

const putDependencies = (db: Db, task: TaskId, dependencies: readonly TaskId[]): void => {
  db.prepare("DELETE FROM deps WHERE task_id = ?").run(task);
  const insert = db.prepare("INSERT INTO deps (task_id, depends_on) VALUES (?, ?)");
  for (const dependency of dependencies) insert.run(task, dependency);
};

const appendEvent = (
  db: Db,
  kind: EventKind,
  snapshot: Snapshot,
  now: string,
  options: WriteOptions,
  extra: JsonObject = {},
): void => {
  const previous = db.prepare("SELECT at FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT 1").get(snapshot.task.id);
  validateEventTime(previous === undefined ? undefined : textInput(previous.at, "at"), now);
  db.prepare("INSERT INTO events (at, actor, kind, task_id, payload, idem_key) VALUES (?, ?, ?, ?, ?, ?)")
    .run(now, options.actor ?? "caller", kind, snapshot.task.id, JSON.stringify({ ...snapshot, ...extra }), options.idem_key ?? null);
};

const withReceipt = <T extends JsonObject>(db: Db, command: string, input: WriteOptions & JsonObject, work: () => T): T | JsonObject => {
  const request = JSON.stringify({ command, input });
  if (input.idem_key !== undefined) {
    const existing = db.prepare("SELECT request, response FROM request_receipts WHERE idem_key = ?").get(input.idem_key);
    if (existing !== undefined) {
      if (existing.request !== request) {
        throw failure("E_IDEMPOTENCY", "This idempotency key already identifies a different request.", "Retry the original request, or use a new key for the new request.");
      }
      return jsonObject(json(existing.response));
    }
  }
  const response = work();
  if (input.idem_key !== undefined) {
    db.prepare("INSERT INTO request_receipts (idem_key, request, response) VALUES (?, ?, ?)")
      .run(input.idem_key, request, JSON.stringify(response));
  }
  return response;
};

export const addTask = (db: Db, input: AddInput, now: string, rng: Rng): JsonObject => withReceipt(db, "add", input, () => {
  const sequence = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events").get()?.next;
  const id = input.id ?? idInput(`task-${rng.int(0x100000000).toString(16).padStart(8, "0")}-${String(sequence)}`);
  if (findTask(db, id) !== undefined) throw failure("E_DUPLICATE", `Task ${id} already exists.`, "Use update for an existing task, or choose a new id.");
  const task = newTask(input, id, now);
  const graph = new Map(loadGraph(db));
  graph.set(id, new Set(input.depends_on));
  validateGraph(graph);
  appendEvent(db, "created", { task, depends_on: input.depends_on }, now, input);
  putTask(db, task);
  putDependencies(db, id, input.depends_on);
  return { task: taskWithDependencies(db, task) };
});

export const updateTask = (db: Db, input: UpdateInput, now: string): JsonObject => withReceipt(db, "update", input, () => {
  const before = getTask(db, input.id);
  const after: Task = { ...before, ...input.patch, updated_at: now };
  if (!sameTask(before, after)) {
    appendEvent(db, "updated", { task: after, depends_on: dependencyIds(db, input.id) }, now, input);
    putTask(db, after);
  }
  return { task: taskWithDependencies(db, getTask(db, input.id)) };
});

export const changeStatus = (db: Db, input: StatusInput, now: string): JsonObject => withReceipt(db, "status", input, () => {
  const before = getTask(db, input.id);
  validateTransition(before.status, input.status, input.reopen);
  if (before.status !== input.status || input.note !== undefined) {
    const after: Task = { ...before, status: input.status, updated_at: now };
    appendEvent(db, "status", { task: after, depends_on: dependencyIds(db, input.id) }, now, input,
      { reopen: input.reopen, ...(input.note === undefined ? {} : { note: input.note }) });
    putTask(db, after);
  }
  return { task: taskWithDependencies(db, getTask(db, input.id)) };
});

export const changeDependency = (db: Db, input: DepInput, now: string, operation: "add" | "rm"): JsonObject =>
  withReceipt(db, `dep ${operation}`, input, () => {
    const before = getTask(db, input.task_id);
    const graph = loadGraph(db);
    if (!graph.has(input.depends_on)) {
      throw failure("E_UNKNOWN_DEP", `Dependency ${input.depends_on} does not exist.`, "Add the prerequisite first, or choose an existing task id.");
    }
    const dependencies = new Set(graph.get(input.task_id) ?? []);
    const changed = operation === "add" ? !dependencies.has(input.depends_on) : dependencies.has(input.depends_on);
    if (operation === "add") {
      const added = addDep(graph, input.task_id, input.depends_on);
      if (!added.ok) throw failure("E_CYCLE", "This dependency would form a cycle.", "Remove an edge from data.cycle before adding this dependency.", { cycle: added.error.cycle });
      dependencies.add(input.depends_on);
    } else dependencies.delete(input.depends_on);
    if (changed) {
      const task = { ...before, updated_at: now };
      const dependsOn = [...dependencies].sort();
      appendEvent(db, operation === "add" ? "dep_added" : "dep_removed", { task, depends_on: dependsOn }, now, input);
      putTask(db, task);
      putDependencies(db, task.id, dependsOn);
    }
    return { task: taskWithDependencies(db, getTask(db, input.task_id)) };
  });

export const importTasks = (db: Db, input: ImportInput, now: string): JsonObject => withReceipt(db, "import", input, () => {
  const { changes, unchanged } = planImport(listTasks(db), loadGraph(db), input, now);
  for (const { task } of changes) putTask(db, task);
  for (const [index, { task, depends_on: dependsOn }] of changes.entries()) {
    appendEvent(db, "imported", { task, depends_on: dependsOn }, now,
      { ...(input.actor === undefined ? {} : { actor: input.actor }), ...(index === 0 && input.idem_key !== undefined ? { idem_key: input.idem_key } : {}) });
    putDependencies(db, task.id, dependsOn);
  }
  const created = changes.filter((entry) => entry.created).length;
  return { created, updated: changes.length - created, unchanged };
});

const eventRow = (row: Readonly<Record<string, unknown>>): TaskEvent => {
  const kind = EVENT_KINDS.find((value) => value === row.kind);
  if (kind === undefined || typeof row.seq !== "number" || !Number.isSafeInteger(row.seq) || row.seq < 1) return databaseError();
  return {
    seq: row.seq,
    at: textInput(row.at, "at"),
    actor: textInput(row.actor, "actor"),
    kind,
    task_id: idInput(row.task_id, "task_id"),
    payload: jsonObject(json(row.payload)),
    idem_key: row.idem_key === null ? null : textInput(row.idem_key, "idem_key"),
  };
};

const allEvents = (db: Db): readonly TaskEvent[] => db.prepare("SELECT * FROM events ORDER BY seq").all().map(eventRow);

export const history = (db: Db, id: TaskId): readonly TaskEvent[] => {
  getTask(db, id);
  return db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY seq").all(id).map(eventRow);
};

const eventSnapshot = (event: TaskEvent): Snapshot => {
  const task = storedTask(event.payload.task);
  const rawDependencies = event.payload.depends_on;
  if (task.id !== event.task_id || !Array.isArray(rawDependencies)) return databaseError();
  const dependencies = rawDependencies.map((raw: unknown) => idInput(raw, "depends_on"));
  if (new Set(dependencies).size !== dependencies.length) return databaseError();
  return { task, depends_on: dependencies };
};

export const processEvents = (db: Db): readonly ProcessEvent[] => allEvents(db).map((event) => ({
  seq: event.seq,
  at: event.at,
  task_id: event.task_id,
  status: eventSnapshot(event).task.status,
}));

export const rebuild = (db: Db): JsonObject => {
  const events = allEvents(db);
  const snapshots = new Map<TaskId, Snapshot>();
  for (const event of events) snapshots.set(event.task_id, eventSnapshot(event));
  const graph: Graph = new Map([...snapshots].map(([id, snapshot]) => [id, new Set(snapshot.depends_on)]));
  validateGraph(graph);
  db.prepare("DELETE FROM deps").run();
  db.prepare("DELETE FROM tasks").run();
  for (const { task } of snapshots.values()) putTask(db, task);
  for (const { task, depends_on: dependsOn } of snapshots.values()) putDependencies(db, task.id, dependsOn);
  return { events: events.length, tasks: snapshots.size };
};

export const loadPeople = (db: Db) => parsePeople(db.prepare("SELECT * FROM people ORDER BY id").all().map((row) => ({
  id: row.id,
  ...(row.name === null ? {} : { name: row.name }),
  capacity_days_per_week: row.capacity_days_per_week ?? 0,
  windows: row.windows === null ? [] : json(row.windows),
})));

export const withReadSnapshot = <T>(db: Db, read: () => T): T => {
  if (db.isTransaction) return read();
  db.exec("BEGIN");
  try {
    const result = read();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
};

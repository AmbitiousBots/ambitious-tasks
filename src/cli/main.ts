import { readCommand, writeCommand, type DbContext } from "@ambitious/kit/cli/command";
import { embedded } from "@ambitious/kit/cli/embedded";
import type { JsonObject } from "@ambitious/kit/domain/json";
import {
  addTask, changeDependency, changeStatus, getTask, history, importTasks, listTasks,
  loadGraph, loadPeople, processEvents, rebuild, taskWithDependencies, updateTask, withReadSnapshot,
} from "../db/tasks.ts";
import { parseMetrics, parseSimulation } from "../domain/process-input.ts";
import { processMetrics, simulate } from "../domain/process.ts";
import { inputError, parseAdd, parseCounts, parseDep, parseEmpty, parseFilter, parseId, parseImport, parseListScope, parseNext, parseStatus, parseUpdate } from "../domain/requests.ts";
import { parseScheduleCheck, parseScheduleSuggest } from "../domain/schedule-input.ts";
import { checkSchedule, suggestSchedule } from "../domain/schedule.ts";
import { boardView, graphView, nextTasks, taskCounts } from "../domain/views.ts";
import { runModule } from "./shell.ts";

const readTasks = <Input>(spec: {
  readonly input: (raw: unknown) => Input;
  readonly run: (context: DbContext<Input>) => JsonObject;
}) => readCommand({ input: spec.input, run: (context) => withReadSnapshot(context.db, () => spec.run(context)) });

await runModule({
  ...embedded(),
  schemaVersion: 1,
  commands: {
    add: writeCommand({ input: parseAdd, run: ({ db, input, clock, rng }) => addTask(db, input, clock.now().toISOString(), rng) }),
    update: writeCommand({ input: parseUpdate, run: ({ db, input, clock }) => updateTask(db, input, clock.now().toISOString()) }),
    status: writeCommand({ input: parseStatus, run: ({ db, input, clock }) => changeStatus(db, input, clock.now().toISOString()) }),
    "dep add": writeCommand({ input: parseDep, run: ({ db, input, clock }) => changeDependency(db, input, clock.now().toISOString(), "add") }),
    "dep rm": writeCommand({ input: parseDep, run: ({ db, input, clock }) => changeDependency(db, input, clock.now().toISOString(), "rm") }),
    get: readTasks({ input: parseId, run: ({ db, input }) => ({ tasks: [taskWithDependencies(db, getTask(db, input.id))] }) }),
    list: readTasks({ input: parseFilter, run: ({ db, input }) => ({ tasks: listTasks(db, input).map((task) => taskWithDependencies(db, task)) }) }),
    import: writeCommand({ input: parseImport, run: ({ db, input, clock }) => importTasks(db, input, clock.now().toISOString()) }),
    next: readTasks({ input: parseNext, run: ({ db, input, clock }) => nextTasks(listTasks(db), loadGraph(db), clock.now().toISOString(), input) }),
    graph: readTasks({ input: parseListScope, run: ({ db, input }) => graphView(listTasks(db), loadGraph(db), input.list) }),
    board: readTasks({ input: parseFilter, run: ({ db, input }) => boardView(listTasks(db, input)) }),
    counts: readTasks({ input: parseCounts, run: ({ db, input, clock }) => taskCounts(listTasks(db), processEvents(db), clock.now().toISOString(), input.list) }),
    history: readTasks({ input: parseId, run: ({ db, input }) => ({ events: history(db, input.id) }) }),
    rebuild: writeCommand({ input: parseEmpty, run: ({ db }) => rebuild(db) }),
    "process metrics": readTasks({ input: parseMetrics, run: ({ db, input, clock }) => {
      const now = clock.now().toISOString();
      if (input.from !== undefined && input.from > now) inputError("from must not be later than --now.");
      return processMetrics(listTasks(db), processEvents(db), now, input);
    } }),
    "process simulate": readTasks({ input: parseSimulation, run: ({ db, input, clock, rng }) => simulate(listTasks(db), loadGraph(db), clock.now().toISOString(), rng, input) }),
    "schedule suggest": readTasks({ input: parseScheduleSuggest, run: ({ db, input, clock }) => suggestSchedule(listTasks(db), loadGraph(db), loadPeople(db), clock.now().toISOString(), input) }),
    "schedule check": readTasks({ input: parseScheduleCheck, run: ({ db, input, clock }) => checkSchedule(listTasks(db), loadGraph(db), loadPeople(db), clock.now().toISOString(), input) }),
  },
}, new Set(["list", "next", "graph", "board", "rebuild", "process metrics"]));

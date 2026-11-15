import { failure } from "@ambitious/kit/domain/failure";
import { CLOSED_STATUSES, OPEN_STATUSES, type Graph, type Status, type Task, type TaskId } from "./types.ts";

export type ProcessEvent = {
  readonly seq: number;
  readonly at: string;
  readonly task_id: TaskId;
  readonly status: Status;
};

export type MetricsInput = {
  readonly list?: string;
  readonly from?: string;
  readonly to?: string;
};

export type Scenario = {
  readonly name: string;
  readonly capacity_change?: number;
  readonly wip_limit?: number;
};

export type SimulationInput = {
  readonly list?: string;
  readonly scenarios: readonly Scenario[];
  readonly runs: number;
};

const DAY = 86_400_000;
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
const selected = (tasks: readonly Task[], list: string | undefined): readonly Task[] =>
  tasks.filter((task) => list === undefined || task.list === list).sort((a, b) => compareText(a.id, b.id));
const percentile = (values: readonly number[], fraction: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
};

export const processMetrics = (
  tasks: readonly Task[],
  events: readonly ProcessEvent[],
  now: string,
  input: MetricsInput,
) => {
  const included = selected(tasks, input.list);
  const cutoff = Math.min(Date.parse(input.to ?? now), Date.parse(now));
  const beginning = input.from === undefined ? Math.min(cutoff, Date.parse(included.reduce((earliest, task) =>
    task.created_at < earliest ? task.created_at : earliest, now))) : Date.parse(input.from);
  const statusTotals = new Map<Status, { days: number; tasks: Set<TaskId> }>(
    [...OPEN_STATUSES, ...CLOSED_STATUSES].map((status) => [status, { days: 0, tasks: new Set<TaskId>() }]),
  );
  const cycleDays: number[] = [];
  let completed = 0;
  for (const task of included) {
    const timeline = events.filter((event) => event.task_id === task.id && Date.parse(event.at) <= cutoff)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq);
    const first = timeline[0];
    if (first === undefined) continue;
    let status = first.status;
    let since = Math.max(Date.parse(task.created_at), Date.parse(first.at));
    let cycleStart: number | null = first.status === "in_progress" ? since : null;
    let opened = since;
    const record = (until: number): void => {
      const days = Math.max(0, Math.min(cutoff, until) - Math.max(beginning, since)) / DAY;
      const total = statusTotals.get(status);
      if (total !== undefined && days > 0) {
        total.days += days;
        total.tasks.add(task.id);
      }
    };
    for (const event of timeline.slice(1)) {
      if (event.status === status) continue;
      const at = Date.parse(event.at);
      record(at);
      if ((status === "done" || status === "canceled") && event.status !== "done" && event.status !== "canceled") {
        opened = at;
        cycleStart = null;
      }
      if (event.status === "in_progress" && cycleStart === null) cycleStart = at;
      if (event.status === "done" && at >= beginning && at <= cutoff) {
        completed += 1;
        cycleDays.push((at - (cycleStart ?? opened)) / DAY);
      }
      status = event.status;
      since = at;
    }
    record(cutoff);
  }
  const wait = [...statusTotals].map(([status, total]) => ({
    status,
    total_days: round(total.days),
    mean_days: total.tasks.size === 0 ? 0 : round(total.days / total.tasks.size),
    tasks: total.tasks.size,
  }));
  const windowDays = Math.max(0, cutoff - beginning) / DAY;
  return {
    from: new Date(beginning).toISOString(),
    to: new Date(cutoff).toISOString(),
    status_wait_days: wait,
    cycle_time_days: { p50: percentile(cycleDays, 0.5), p90: percentile(cycleDays, 0.9), samples: cycleDays.length },
    throughput: { completed, days: round(windowDays), tasks_per_day: windowDays === 0 ? 0 : round(completed / windowDays) },
    bottlenecks: wait.filter(({ status }) => status === "todo" || status === "blocked" || status === "waiting")
      .sort((a, b) => b.total_days - a.total_days || compareText(a.status, b.status)),
  };
};

const simulatedDuration = (
  tasks: readonly Task[],
  graph: Graph,
  samples: ReadonlyMap<TaskId, number>,
  scenario: Scenario,
) => {
  const done = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id));
  const pending = new Map(tasks.filter((task) => task.status !== "done" && task.status !== "canceled")
    .map((task) => [task.id, task]));
  const running = new Map<TaskId, number>();
  const capacity = 1 + (scenario.capacity_change ?? 0);
  const slots = scenario.wip_limit ?? 1;
  let time = 0;
  while (pending.size > 0 || running.size > 0) {
    for (const [id] of pending) {
      if (running.size >= slots) break;
      if ([...(graph.get(id) ?? [])].some((dependency) => !done.has(dependency))) continue;
      running.set(id, time + (samples.get(id) ?? 1) / capacity);
      pending.delete(id);
    }
    if (running.size === 0) return { days: null, blocked: [...pending.keys()].sort(compareText) };
    time = Math.min(...running.values());
    for (const [id, finish] of running) {
      if (finish <= time) {
        done.add(id);
        running.delete(id);
      }
    }
  }
  return { days: time, blocked: [] };
};

export const simulate = (
  tasks: readonly Task[],
  graph: Graph,
  now: string,
  rng: { readonly next: () => number },
  input: SimulationInput,
) => {
  const included = selected(tasks, input.list);
  const includedIds = new Set(included.map(({ id }) => id));
  const analysisTasks = tasks.filter((task) => includedIds.has(task.id) || task.status === "done")
    .sort((a, b) => compareText(a.id, b.id));
  const results: { scenario: Scenario; days: number[]; blocked: readonly TaskId[] }[] =
    input.scenarios.map((scenario) => ({ scenario, days: [], blocked: [] }));
  for (let run = 0; run < input.runs; run += 1) {
    const samples = new Map(included.filter((task) => task.status !== "done" && task.status !== "canceled")
      .map((task) => [task.id, (task.estimate_days ?? 1) * (0.75 + rng.next() * 0.5)]));
    for (const result of results) {
      const duration = simulatedDuration(analysisTasks, graph, samples, result.scenario);
      if (duration.days !== null && !Number.isFinite(duration.days)) {
        throw failure("E_RANGE", "The simulated duration exceeds the supported numeric range.", "Reduce task estimates or increase scenario capacity.");
      }
      if (duration.days !== null) result.days.push(duration.days);
      result.blocked = duration.blocked;
    }
  }
  const date = (days: number | null): string | null => {
    if (days === null) return null;
    const time = new Date(Date.parse(now) + days * DAY);
    if (!Number.isFinite(time.getTime())) {
      throw failure("E_RANGE", "The simulated finish exceeds the supported date range.", "Reduce task estimates or increase scenario capacity.");
    }
    return time.toISOString();
  };
  return {
    runs: input.runs,
    scenarios: results.map(({ scenario, days, blocked }) => {
      const p50 = percentile(days, 0.5);
      const p90 = percentile(days, 0.9);
      return {
        name: scenario.name,
        finish: { p50: date(p50), p90: date(p90) },
        duration_days: { p50, p90 },
        blocked,
      };
    }),
  };
};

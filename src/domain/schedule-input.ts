import { parseNow } from "@ambitious/kit/domain/clock";
import { failure } from "@ambitious/kit/domain/failure";
import { isRecord } from "@ambitious/kit/domain/json";
import type { Assignment, CheckInput, Person, SuggestInput, Window } from "./schedule.ts";
import { isTaskId } from "./types.ts";

const invalid = (field: string, expected: string): never => {
  throw failure("E_INPUT_SCHEMA", `The field ${field} must be ${expected}.`, "Send a JSON object with valid schedule fields.");
};
const object = (raw: unknown, allowed: readonly string[]): Readonly<Record<string, unknown>> => {
  if (!isRecord(raw)) return invalid("input", "an object");
  if (Object.keys(raw).some((field) => !allowed.includes(field))) return invalid("input", "an object containing only documented schedule fields");
  return raw;
};
const text = (raw: unknown, field: string): string => {
  if (typeof raw !== "string" || raw.trim().length === 0) return invalid(field, "a nonempty string");
  return raw;
};
const instant = (raw: unknown, field: string): string => {
  const parsed = typeof raw === "string" ? parseNow(raw) : null;
  if (parsed === null) {
    return invalid(field, "an ISO timestamp with a time zone");
  }
  return parsed.toISOString();
};
const number = (raw: unknown, field: string, minimum: number, maximum: number): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < minimum || raw > maximum) {
    return invalid(field, `a finite number from ${minimum} to ${maximum}`);
  }
  return raw;
};
const windows = (raw: unknown): readonly Window[] => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return invalid("windows", "an array of { start, end } timestamps");
  return raw.map((entry: unknown) => {
    const record = object(entry, ["start", "end"]);
    const start = instant(record.start, "windows.start");
    const end = instant(record.end, "windows.end");
    if (start >= end) return invalid("windows.end", "after windows.start");
    return { start, end };
  });
};
export const parsePeople = (raw: unknown): readonly Person[] => {
  if (!Array.isArray(raw)) return invalid("people", "an array");
  const ids = new Set<string>();
  return raw.map((entry: unknown) => {
    const record = object(entry, ["id", "name", "capacity_days_per_week", "windows"]);
    const id = text(record.id, "people.id");
    if (ids.has(id)) return invalid("people.id", "unique within the roster");
    ids.add(id);
    return {
      id,
      ...(record.name === undefined || record.name === null ? {} : { name: text(record.name, "people.name") }),
      capacity_days_per_week: number(record.capacity_days_per_week, "capacity_days_per_week", 0, 7),
      windows: windows(record.windows),
    };
  });
};
const SUGGEST_HINT = 'Send horizon_days and people together, for example {"horizon_days":14,"people":[{"id":"member","capacity_days_per_week":5,"windows":[{"start":"2026-01-05T09:00:00Z","end":"2026-01-09T17:00:00Z"}]}]}. ' +
  "The window dates are placeholders: each window must fall between the command time and horizon_days later. Leave windows out for a person who is always available. " +
  "people is optional, but it is not stored: without it the command reads the stored people table, which is normally empty, and every task then reports NO_FEASIBLE_SLOT.";
const shared = (raw: Readonly<Record<string, unknown>>) => ({
  ...(raw.people === undefined ? {} : { people: parsePeople(raw.people) }),
});
export const parseScheduleSuggest = (raw: unknown): SuggestInput => {
  const record = object(raw, ["list", "people", "horizon_days"]);
  if (record.horizon_days === undefined) {
    throw failure("E_INPUT_SCHEMA",
      record.people === undefined
        ? "schedule suggest needs horizon_days, a number of days from 0 to 36600, and a people roster: people is a list of { id, capacity_days_per_week, windows }. Neither was sent."
        : "schedule suggest needs horizon_days, a number of days from 0 to 36600, beside the people roster.",
      SUGGEST_HINT);
  }
  return {
    ...shared(record),
    ...(record.list === undefined ? {} : { list: text(record.list, "list") }),
    horizon_days: number(record.horizon_days, "horizon_days", 0, 36_600),
  };
};
const parseAssignment = (raw: unknown): Assignment => {
  const record = object(raw, ["task_id", "person_id", "start", "end"]);
  const id = text(record.task_id, "task_id");
  if (!isTaskId(id)) return invalid("task_id", "a task identifier with no surrounding whitespace");
  return { task_id: id, person_id: text(record.person_id, "person_id"), start: instant(record.start, "start"), end: instant(record.end, "end") };
};
export const parseScheduleCheck = (raw: unknown): CheckInput => {
  const record = object(raw, ["assignments", "people", "horizon_days"]);
  if (!Array.isArray(record.assignments)) return invalid("assignments", "an array");
  return {
    ...shared(record),
    ...(record.horizon_days === undefined ? {} : { horizon_days: number(record.horizon_days, "horizon_days", 0, 36_600) }),
    assignments: record.assignments.map(parseAssignment),
  };
};

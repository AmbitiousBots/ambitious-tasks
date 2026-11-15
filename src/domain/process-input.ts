import { parseNow } from "@ambitious/kit/domain/clock";
import { inputError, objectInput, textInput } from "./requests.ts";
import type { MetricsInput, Scenario, SimulationInput } from "./process.ts";

const instant = (raw: unknown, field: string): string => {
  const value = textInput(raw, field);
  const parsed = parseNow(value);
  if (parsed === null) {
    return inputError(`${field} must be an ISO timestamp with a time zone.`);
  }
  return parsed.toISOString();
};

export const parseMetrics = (raw: unknown): MetricsInput => {
  const value = objectInput(raw, ["list", "from", "to"]);
  const from = value.from === undefined ? undefined : instant(value.from, "from");
  const to = value.to === undefined ? undefined : instant(value.to, "to");
  if (from !== undefined && to !== undefined && from > to) inputError("from must not be later than to.");
  return {
    ...(value.list === undefined ? {} : { list: textInput(value.list, "list") }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
};

const positiveInteger = (raw: unknown, field: string, maximum: number): number => {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > maximum) {
    return inputError(`${field} must be an integer from 1 to ${maximum}.`);
  }
  return raw;
};

const parseScenario = (raw: unknown): Scenario => {
  const value = objectInput(raw, ["name", "capacity_change", "wip_limit"]);
  const capacity = value.capacity_change;
  if (capacity !== undefined && (typeof capacity !== "number" || !Number.isFinite(capacity) || capacity <= -1 || capacity > 1000)) {
    return inputError("capacity_change must be greater than -1 and at most 1000.");
  }
  return {
    name: textInput(value.name, "name"),
    ...(capacity === undefined ? {} : { capacity_change: capacity }),
    ...(value.wip_limit === undefined ? {} : { wip_limit: positiveInteger(value.wip_limit, "wip_limit", 10000) }),
  };
};

export const parseSimulation = (raw: unknown): SimulationInput => {
  const value = objectInput(raw, ["list", "scenarios", "runs"]);
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0 || value.scenarios.length > 100) {
    return inputError("scenarios must be an array containing 1 to 100 scenarios.");
  }
  const scenarios = value.scenarios.map(parseScenario);
  if (new Set(scenarios.map(({ name }) => name)).size !== scenarios.length) inputError("Scenario names must be unique.");
  return {
    ...(value.list === undefined ? {} : { list: textInput(value.list, "list") }),
    scenarios,
    runs: value.runs === undefined ? 1000 : positiveInteger(value.runs, "runs", 10000),
  };
};

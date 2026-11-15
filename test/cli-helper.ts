import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { isRecord } from "@ambitious/kit/domain/json";

export const object = (value: unknown): Readonly<Record<string, unknown>> => {
  assert.ok(isRecord(value), "Expected a JSON object");
  return value;
};

export const items = (value: unknown): readonly unknown[] => {
  assert.ok(Array.isArray(value), "Expected a JSON array");
  return value;
};

export const scratch = (t: TestContext): string => {
  const home = mkdtempSync(join(tmpdir(), "tasks-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
};

export const run = (home: string, command: string, input: unknown = {}, now = "2026-01-01T00:00:00Z", seed = 7) => {
  const result = spawnSync(process.execPath, ["dist/ambitious-tasks.mjs", ...command.split(" "), "--now", now, "--seed", String(seed)], {
    input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, AMBITIOUS_HOME: home },
  });
  assert.ifError(result.error);
  const parsed: unknown = JSON.parse(result.stdout);
  const envelope = object(parsed);
  assert.equal(result.stdout.trimEnd().split("\n").length, 1);
  assert.equal(envelope.module, "tasks");
  assert.equal(envelope.command, command);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, envelope, data: object(envelope.data) };
};

export const success = (home: string, command: string, input: unknown = {}, now?: string) => {
  const result = run(home, command, input, now);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.envelope.ok, true);
  assert.deepEqual(result.envelope.errors, []);
  return result.data;
};

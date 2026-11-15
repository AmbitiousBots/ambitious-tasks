import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import { items, object, run, scratch, success } from "./cli-helper.ts";

const features = ["commands", "selfcheck", "add", "update", "status", "dep-add", "dep-rm", "get", "list", "import", "next", "graph", "board", "history", "rebuild", "process-metrics", "process-simulate", "schedule-suggest", "schedule-check"];
for (const feature of features) {
  test(`the built CLI proves ${feature} through its JSON interface`, (t) => {
    const result = spawnSync(process.execPath, ["scripts/verify-feature.mjs", feature], {
      encoding: "utf8", env: { ...process.env, AMBITIOUS_HOME: scratch(t) },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

test("invalid input is rejected before creating a database", (t) => {
  const home = scratch(t);
  const result = run(home, "add", { title: "", estimate_days: -1 });
  assert.equal(result.status, 1);
  assert.equal(object(items(result.envelope.errors)[0]).code, "E_INPUT_SCHEMA");
  assert.equal(existsSync(join(home, "tasks/tasks.sqlite")), false);
});

test("an idempotency retry returns its original answer after later edits and no-op requests reserve their keys", (t) => {
  const home = scratch(t);
  const add = { id: "one", title: "Original", idem_key: "create" };
  const first = success(home, "add", add);
  success(home, "update", { id: "one", patch: { title: "Later" } });
  assert.deepEqual(success(home, "add", add), first);
  const noop = { id: "one", status: "todo", idem_key: "keep-state" };
  const unchanged = success(home, "status", noop);
  success(home, "status", { id: "one", status: "done" });
  assert.deepEqual(success(home, "status", noop), unchanged);
  assert.equal(object(items(success(home, "get", { id: "one" }).tasks)[0]).status, "done");
  const conflict = run(home, "status", { id: "one", status: "todo", reopen: true, idem_key: "keep-state" });
  assert.equal(object(items(conflict.envelope.errors)[0]).code, "E_IDEMPOTENCY");
});

test("an import cannot reopen done work or change anything when a later row fails", (t) => {
  const home = scratch(t);
  success(home, "add", { id: "one", title: "Original" });
  success(home, "add", { id: "two", title: "Completed" });
  success(home, "status", { id: "two", status: "done" });
  const before = success(home, "list");
  const history = success(home, "history", { id: "one" });
  const result = run(home, "import", { schemaVersion: 1, tasks: [
    { id: "one", title: "Would change" }, { id: "two", title: "Would reopen", status: "todo" },
  ] });
  assert.equal(result.status, 1);
  assert.equal(object(items(result.envelope.errors)[0]).code, "E_TRANSITION");
  assert.deepEqual(success(home, "list"), before);
  assert.deepEqual(success(home, "history", { id: "one" }), history);
});

test("next checks dependencies outside the requested list", (t) => {
  const home = scratch(t);
  success(home, "add", { id: "prerequisite", title: "Outside", list: "other" });
  success(home, "add", { id: "dependent", title: "Inside", list: "selected", depends_on: ["prerequisite"] });
  assert.deepEqual(success(home, "next", { list: "selected" }).ranked, []);
  success(home, "status", { id: "prerequisite", status: "done" });
  assert.deepEqual(items(success(home, "next", { list: "selected" }).ranked).map((value) => object(value).id), ["dependent"]);
});

test("the same input time and seed generate the same task identifier", (t) => {
  const a = scratch(t);
  const b = scratch(t);
  const input = { title: "Repeatable identifier", idem_key: "create" };
  assert.equal(run(a, "add", input).stdout, run(b, "add", input).stdout);
});

test("simultaneous retries commit one task and one creation event", async (t) => {
  const home = scratch(t);
  success(home, "selfcheck");
  const launch = (): Promise<string> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/ambitious-tasks.mjs", "add", "--now", "2026-01-01T00:00:00Z", "--seed", "7"], {
      env: { ...process.env, AMBITIOUS_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
    child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stdout + stderr)));
    child.stdin.end(JSON.stringify({ id: "one", title: "Once", idem_key: "simultaneous" }));
  });
  const outputs = await Promise.all([launch(), launch(), launch()]);
  assert.equal(new Set(outputs).size, 1);
  assert.equal(items(success(home, "list").tasks).length, 1);
  assert.equal(items(success(home, "history", { id: "one" }).events).length, 1);
});

test("replaying generated sequences preserves every task dependency and event", (t) => {
  const home = scratch(t);
  let sample = 0;
  fc.assert(fc.property(fc.array(fc.record({
    target: fc.integer({ min: 0, max: 2 }),
    action: fc.constantFrom("edit", "status", "add-dep", "remove-dep"),
    status: fc.constantFrom("todo", "in_progress", "blocked", "waiting", "done", "canceled"),
  }), { minLength: 1, maxLength: 12 }), (steps) => {
    sample += 1;
    const ids = [0, 1, 2].map((index) => `sample-${sample}-${index}`);
    for (const id of ids) success(home, "add", { id, title: id });
    for (const [index, step] of steps.entries()) {
      const id = ids[step.target];
      assert.ok(id);
      if (step.action === "edit") success(home, "update", { id, patch: { notes: `edit-${index}` } });
      if (step.action === "status") {
        const current = object(items(success(home, "get", { id }).tasks)[0]).status;
        success(home, "status", current === "done" && step.status !== "done"
          ? { id, status: "todo", reopen: true }
          : { id, status: step.status });
      }
      if (step.target > 0 && (step.action === "add-dep" || step.action === "remove-dep")) {
        success(home, step.action === "add-dep" ? "dep add" : "dep rm", { task_id: id, depends_on: ids[step.target - 1] });
      }
    }
    const before = success(home, "list");
    const graph = success(home, "graph");
    const histories = ids.map((id) => success(home, "history", { id }));
    success(home, "rebuild");
    assert.deepEqual(success(home, "list"), before);
    assert.deepEqual(success(home, "graph"), graph);
    assert.deepEqual(ids.map((id) => success(home, "history", { id })), histories);
  }), { numRuns: 30, seed: 731 });
});

test("imports accept both supported input versions and reject unknown versions without changing tasks", (t) => {
  const home = scratch(t);
  for (const schemaVersion of [1, 2]) {
    assert.deepEqual(success(home, "import", { schemaVersion, tasks: [{ id: `version-${schemaVersion}`, title: "Imported" }] }), { created: 1, updated: 0, unchanged: 0 });
  }
  const before = success(home, "list");
  const result = run(home, "import", { schemaVersion: 99, tasks: [{ id: "unsupported", title: "Rejected" }] });
  assert.equal(result.status, 1);
  assert.equal(object(items(result.envelope.errors)[0]).code, "E_INPUT_SCHEMA");
  assert.deepEqual(success(home, "list"), before);
});

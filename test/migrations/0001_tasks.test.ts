import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { loadMigrations } from "@ambitious/kit/db/load-migrations";
import { migrate } from "@ambitious/kit/db/migrate";
import { openDb, readUserVersion } from "@ambitious/kit/db/open-db";
import { scratch, success } from "../cli-helper.ts";
import { listTasks, withReadSnapshot } from "../../src/db/tasks.ts";

test("the initial migration creates task storage once and preserves existing rows on later starts", (t) => {
  const home = scratch(t);
  success(home, "add", { id: "kept", title: "Retained task", idem_key: "create-kept" });
  const db = openDb(join(home, "tasks/tasks.sqlite"), { readonly: false });
  t.after(() => db.close());
  const before = db.prepare("SELECT * FROM tasks").all();
  assert.deepEqual(migrate(db, loadMigrations("migrations")), []);
  assert.equal(readUserVersion(db), 1);
  assert.deepEqual(db.prepare("SELECT * FROM tasks").all(), before);
  assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name);
  for (const name of ["tasks", "events", "deps", "people"]) assert.ok(names.includes(name));
  assert.throws(() => db.prepare("INSERT INTO deps VALUES (?, ?)").run("kept", "missing"), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO deps VALUES (?, ?)").run("kept", "kept"), /CHECK/);
  assert.throws(() => db.prepare("UPDATE tasks SET priority = 8").run(), /CHECK/);
  const events = db.prepare("SELECT * FROM events").all();
  assert.throws(() => db.exec("UPDATE events SET actor = 'changed'"), /append|immutable/i);
  assert.throws(() => db.exec("DELETE FROM events"), /append|immutable/i);
  assert.deepEqual(db.prepare("SELECT * FROM events").all(), events);
});

test("analysis connections reject writes at SQLite level", (t) => {
  const home = scratch(t);
  success(home, "add", { id: "readable", title: "Read only" });
  const db = openDb(join(home, "tasks/tasks.sqlite"), { readonly: true });
  t.after(() => db.close());
  assert.throws(() => db.exec("UPDATE tasks SET title = 'changed'"), /readonly/);
  assert.equal(db.prepare("SELECT title FROM tasks").get()?.title, "Read only");
});

test("a read-only analysis keeps one snapshot while another process commits", (t) => {
  const home = scratch(t);
  success(home, "add", { id: "one", title: "Before" });
  const db = openDb(join(home, "tasks/tasks.sqlite"), { readonly: true });
  t.after(() => db.close());
  withReadSnapshot(db, () => {
    assert.equal(listTasks(db)[0]?.status, "todo");
    success(home, "status", { id: "one", status: "done" });
    assert.equal(listTasks(db)[0]?.status, "todo");
  });
  assert.equal(listTasks(db)[0]?.status, "done");
});

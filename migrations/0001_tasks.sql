CREATE TABLE events (
  seq INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'updated', 'status', 'dep_added', 'dep_removed', 'imported')),
  task_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  idem_key TEXT UNIQUE
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  list TEXT NOT NULL DEFAULT 'default',
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('todo', 'in_progress', 'blocked', 'waiting', 'done', 'canceled')),
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  estimate_days REAL CHECK (estimate_days IS NULL OR estimate_days >= 0),
  due TEXT,
  assignee TEXT,
  labels TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(labels)),
  done_when TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE deps (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on),
  CHECK (task_id <> depends_on)
);

CREATE TABLE people (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT,
  capacity_days_per_week REAL CHECK (capacity_days_per_week IS NULL OR capacity_days_per_week >= 0),
  windows TEXT CHECK (windows IS NULL OR json_valid(windows))
);

CREATE TABLE request_receipts (
  idem_key TEXT PRIMARY KEY NOT NULL,
  request TEXT NOT NULL CHECK (json_valid(request)),
  response TEXT NOT NULL CHECK (json_valid(response))
);

CREATE INDEX events_by_task ON events(task_id, seq);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'Event history is append-only');
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'Event history is append-only');
END;

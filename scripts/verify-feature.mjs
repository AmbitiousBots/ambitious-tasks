import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [feature] = process.argv.slice(2);
assert.ok(process.env.AMBITIOUS_HOME, 'Set AMBITIOUS_HOME to a fresh directory.');
const now = '2026-01-01T00:00:00Z';
const invoke = (command, input = {}, time = now, extra = []) => {
  const result = spawnSync(process.execPath, ['dist/ambitious-tasks.mjs', ...command.split(' '), '--now', time, '--seed', '7', ...extra], {
    input: input === undefined ? '' : JSON.stringify(input), encoding: 'utf8', env: process.env,
  });
  assert.ifError(result.error);
  assert.equal(result.stdout.trimEnd().split('\n').length, 1, result.stderr);
  const answer = JSON.parse(result.stdout);
  assert.equal(answer.module, 'tasks');
  assert.equal(answer.command, command);
  assert.deepEqual(Object.keys(answer), ['ok', 'schemaVersion', 'module', 'command', 'data', 'errors', 'meta']);
  return { ...result, answer };
};
const ok = (command, input = {}, time = now) => {
  const result = invoke(command, input, time);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.answer.ok, true);
  assert.deepEqual(result.answer.errors, []);
  return result.answer.data;
};
const refused = (command, input, code) => {
  const result = invoke(command, input);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.answer.ok, false);
  assert.equal(result.answer.errors[0].code, code);
  return result.answer.data;
};
const add = (id, rest = {}) => ok('add', { id, title: `Work ${id}`, estimate_days: 1, idem_key: `add-${id}`, ...rest });
const importFixture = () => ok('import', JSON.parse(readFileSync('test/fixtures/work-plan.json', 'utf8')));
const hashDb = () => createHash('sha256').update(readFileSync(join(process.env.AMBITIOUS_HOME, 'tasks/tasks.sqlite'))).digest('hex');
const people = [{ id: 'worker-1', name: 'Worker', capacity_days_per_week: 7, windows: [{ start: now, end: '2026-02-01T00:00:00Z' }] }];
const checks = {
  commands: () => {
    const result = ok('commands');
    for (const name of ['add', 'update', 'list move', 'status', 'dep add', 'dep rm', 'get', 'list', 'import', 'next', 'graph', 'board', 'counts', 'history', 'rebuild', 'process metrics', 'process simulate', 'schedule suggest', 'schedule check', 'selfcheck', 'commands']) {
      assert.ok(result.commands.some((entry) => entry.name === name), name);
    }
    for (const name of ['counts', 'process metrics', 'process simulate', 'schedule suggest', 'schedule check']) {
      assert.equal(result.commands.find((entry) => entry.name === name).access, 'read');
    }
  },
  selfcheck: () => {
    const first = ok('selfcheck');
    assert.deepEqual(first.problems, []);
    assert.equal(first.db.integrityCheck, 'ok');
    assert.equal(first.db.userVersion, 1);
    assert.equal(first.runtime.name, 'node');
    assert.match(first.binary.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(ok('selfcheck').db.migrationsApplied, []);
  },
  add: () => {
    const first = add('one');
    assert.equal(first.task.id, 'one');
    assert.equal(first.task.status, 'todo');
    assert.deepEqual(add('one'), first);
    assert.equal(ok('list').tasks.length, 1);
    assert.equal(ok('history', { id: 'one' }).events.length, 1);
    refused('add', { id: 'other', title: 'Changed', idem_key: 'add-one' }, 'E_IDEMPOTENCY');
  },
  update: () => {
    add('one');
    const input = { id: 'one', patch: { title: 'Revised', assignee: 'worker-1', labels: ['planned'] }, idem_key: 'edit-one' };
    const result = ok('update', input);
    assert.equal(result.task.title, 'Revised');
    assert.equal(result.task.assignee, 'worker-1');
    assert.deepEqual(result.task.labels, ['planned']);
    assert.deepEqual(ok('update', input), result);
    assert.equal(ok('history', { id: 'one' }).events.length, 2);
  },
  'list-move': () => {
    add('one', { list: 'inbox', assignee: 'worker-1' });
    const input = { id: 'one', list: 'review', idem_key: 'move-one' };
    const before = ok('get', { id: 'one' }).tasks[0];
    const result = ok('list move', input, '2026-01-02T00:00:00Z');
    assert.equal(result.moved, true);
    assert.equal(result.from_list, 'inbox');
    assert.deepEqual(result.task, { ...before, list: 'review', updated_at: '2026-01-02T00:00:00.000Z' });
    assert.deepEqual(ok('list move', input, '2026-01-03T00:00:00Z'), result);
    assert.deepEqual(ok('get', { id: 'one' }).tasks, [result.task]);
    assert.deepEqual(ok('list', { list: 'review' }).tasks.map(({ id }) => id), ['one']);
    assert.deepEqual(ok('list', { list: 'inbox' }).tasks, []);
    assert.deepEqual(ok('board', { list: 'review' }).columns.find(({ status }) => status === 'todo').tasks.map(({ id }) => id), ['one']);
    const events = ok('history', { id: 'one' }).events;
    assert.deepEqual(events.map(({ kind }) => kind), ['created', 'updated']);
    assert.deepEqual(events[1].payload.list_move, { from: 'inbox', to: 'review' });
    assert.deepEqual(ok('list move', { id: 'one', list: 'review', idem_key: 'stay' }), { task: result.task, moved: false, from_list: 'review' });
    assert.equal(ok('history', { id: 'one' }).events.length, 2);
    refused('list move', { id: 'one', list: 'archive', idem_key: 'move-one' }, 'E_IDEMPOTENCY');
    refused('list move', { id: 'one', list: ' ' }, 'E_INPUT_SCHEMA');
    refused('list move', { id: 'absent', list: 'review' }, 'E_NOT_FOUND');
    ok('update', { id: 'one', patch: { list: 'archive' } }, '2026-01-04T00:00:00Z');
    assert.deepEqual(ok('history', { id: 'one' }).events[2].payload.list_move, { from: 'review', to: 'archive' });
  },
  status: () => {
    add('one');
    assert.equal(ok('status', { id: 'one', status: 'done', idem_key: 'finish-one' }).task.status, 'done');
    refused('status', { id: 'one', status: 'todo' }, 'E_TRANSITION');
    assert.equal(ok('status', { id: 'one', status: 'todo', reopen: true, idem_key: 'reopen-one' }).task.status, 'todo');
  },
  'dep-add': () => {
    add('one');
    add('two');
    ok('dep add', { task_id: 'two', depends_on: 'one', idem_key: 'edge' });
    assert.deepEqual(ok('next').ranked.map(({ id }) => id), ['one']);
    const cycle = refused('dep add', { task_id: 'one', depends_on: 'two' }, 'E_CYCLE').cycle;
    assert.equal(cycle[0], cycle.at(-1));
    assert.equal(ok('graph').edges.length, 1);
    refused('dep add', { task_id: 'one', depends_on: 'absent' }, 'E_UNKNOWN_DEP');
  },
  'dep-rm': () => {
    add('one');
    add('two', { depends_on: ['one'] });
    ok('dep rm', { task_id: 'two', depends_on: 'one', idem_key: 'remove-edge' });
    assert.equal(ok('graph').edges.length, 0);
    assert.deepEqual(ok('next').ranked.map(({ id }) => id).sort(), ['one', 'two']);
  },
  get: () => {
    add('one');
    assert.deepEqual(ok('get', { id: 'one' }).tasks.map(({ id }) => id), ['one']);
    refused('get', { id: 'absent' }, 'E_NOT_FOUND');
  },
  list: () => {
    add('one', { list: 'alpha', labels: ['ready'] });
    add('two', { list: 'beta' });
    assert.deepEqual(ok('list', { list: 'alpha', status: 'todo', label: 'ready' }).tasks.map(({ id }) => id), ['one']);
    assert.deepEqual(ok('list', { status: 'done' }).tasks, []);
  },
  import: () => {
    assert.deepEqual(importFixture(), { created: 104, updated: 0, unchanged: 0 });
    assert.deepEqual(importFixture(), { created: 0, updated: 0, unchanged: 104 });
    const before = ok('list');
    refused('import', { schemaVersion: 1, tasks: [{ id: 'new', title: 'Unknown edge', depends_on: ['missing'] }] }, 'E_UNKNOWN_DEP');
    refused('import', { schemaVersion: 1, tasks: [{ id: 'cycle-a', title: 'First', depends_on: ['cycle-b'] }, { id: 'cycle-b', title: 'Second', depends_on: ['cycle-a'] }] }, 'E_CYCLE');
    assert.deepEqual(ok('list'), before);
  },
  next: () => {
    importFixture();
    const result = ok('next', { limit: 2 });
    assert.deepEqual(result.ranked.map(({ id }) => id), ['task-003', 'task-009']);
    assert.ok(result.ranked[1].reasons.includes('needs approval'));
    assert.ok(result.ranked[1].reasons.includes('owner approval'));
    const statuses = new Map(ok('list').tasks.map((task) => [task.id, task.status]));
    const graph = ok('graph');
    for (const task of result.ranked) {
      assert.ok(!['done', 'canceled'].includes(statuses.get(task.id)));
      for (const edge of graph.edges.filter(({ task_id }) => task_id === task.id)) assert.equal(statuses.get(edge.depends_on), 'done');
    }
    const board = new Map(ok('board').columns.flatMap(({ tasks }) => tasks).map((task) => [task.id, task]));
    for (const { score, reasons, ...fields } of result.ranked) {
      assert.deepEqual(fields, board.get(fields.id));
      assert.equal(typeof score, 'number');
      assert.ok(reasons.includes(`priority ${fields.priority}`));
      assert.ok(reasons.includes(fields.due === null ? 'no due date' : `due ${fields.due}`));
      for (const field of ['assignee', 'due', 'priority', 'status', 'list', 'estimate_days', 'labels']) assert.ok(Object.hasOwn(fields, field), field);
    }
    assert.equal(invoke('next').stdout, invoke('next').stdout);
  },
  graph: () => {
    importFixture();
    const result = ok('graph');
    assert.equal(result.nodes.length, 104);
    assert.equal(result.total_days, 105.5);
    assert.ok(result.critical_path.length > 1);
    assert.ok(result.critical_path_days > 0 && result.critical_path_days <= result.total_days);
    for (let index = 1; index < result.critical_path.length; index += 1) {
      assert.ok(result.edges.some(({ task_id, depends_on }) => task_id === result.critical_path[index] && depends_on === result.critical_path[index - 1]));
    }
  },
  board: () => {
    add('one');
    add('two');
    ok('status', { id: 'two', status: 'done' });
    const columns = ok('board').columns;
    assert.deepEqual(columns.map(({ status }) => status), ['todo', 'in_progress', 'blocked', 'waiting', 'done', 'canceled']);
    assert.deepEqual(columns.find(({ status }) => status === 'todo').tasks.map(({ id }) => id), ['one']);
    assert.deepEqual(columns.find(({ status }) => status === 'done').tasks.map(({ id }) => id), ['two']);
  },
  counts: () => {
    const at = '2026-01-08T00:00:00Z';
    ok('selfcheck');
    assert.deepEqual(ok('counts', {}, at),
      { list: 'default', exists: false, open: null, stale7d: null, blocked: null, waiting: null, done7d: null, asOf: '2026-01-08T00:00:00.000Z',
        note: 'No task has ever been in the list "default", so there is nothing to count. No list has had a task yet.' });
    add('unfiled');
    ok('status', { id: 'unfiled', status: 'done' });
    add('old', { list: 'audit' });
    add('stuck', { list: 'audit' });
    add('paused', { list: 'audit' });
    add('finished', { list: 'audit' });
    add('dropped', { list: 'audit' });
    add('elsewhere', { list: 'other' });
    ok('status', { id: 'stuck', status: 'blocked' }, '2026-01-01T00:00:00.001Z');
    ok('status', { id: 'paused', status: 'waiting' }, '2026-01-05T00:00:00Z');
    ok('status', { id: 'finished', status: 'done' }, '2026-01-05T00:00:00Z');
    ok('status', { id: 'dropped', status: 'canceled' }, '2026-01-05T00:00:00Z');
    const before = hashDb();
    assert.deepEqual(ok('counts', { list: 'audit' }, at),
      { list: 'audit', exists: true, open: 3, stale7d: 1, blocked: 1, waiting: 1, done7d: 1, asOf: '2026-01-08T00:00:00.000Z' });
    assert.deepEqual(ok('counts', { list: 'absent' }, at),
      { list: 'absent', exists: false, open: null, stale7d: null, blocked: null, waiting: null, done7d: null, asOf: '2026-01-08T00:00:00.000Z',
        note: 'No task has ever been in the list "absent", so there is nothing to count. Lists that have had a task: "audit", "default", "other".' });
    assert.deepEqual(ok('counts', {}, at),
      { list: 'default', exists: true, open: 0, stale7d: 0, blocked: 0, waiting: 0, done7d: 0, asOf: '2026-01-08T00:00:00.000Z' });
    refused('counts', { list: '' }, 'E_INPUT_SCHEMA');
    assert.equal(invoke('counts', { list: 'audit' }, at).stdout, invoke('counts', { list: 'audit' }, at).stdout);
    assert.equal(hashDb(), before);
  },
  history: () => {
    add('one');
    ok('update', { id: 'one', patch: { title: 'Edited' }, actor: 'operator' });
    ok('status', { id: 'one', status: 'done', note: 'Acceptance passed' });
    const events = ok('history', { id: 'one' }).events;
    assert.deepEqual(events.map(({ kind }) => kind), ['created', 'updated', 'status']);
    assert.equal(events[1].actor, 'operator');
    assert.ok(JSON.stringify(events[2]).includes('Acceptance passed'));
  },
  rebuild: () => {
    importFixture();
    ok('update', { id: 'task-003', patch: { title: 'Revised work' } });
    ok('status', { id: 'task-003', status: 'in_progress' });
    const tasks = ok('list');
    const graph = ok('graph');
    const history = ok('history', { id: 'task-003' });
    const result = ok('rebuild');
    assert.equal(result.tasks, 104);
    assert.ok(result.events >= 106);
    assert.deepEqual(ok('list'), tasks);
    assert.deepEqual(ok('graph'), graph);
    assert.deepEqual(ok('history', { id: 'task-003' }), history);
  },
  'process-metrics': () => {
    add('one');
    ok('status', { id: 'one', status: 'in_progress' }, '2026-01-03T00:00:00Z');
    ok('status', { id: 'one', status: 'done' }, '2026-01-05T00:00:00Z');
    const before = hashDb();
    const result = ok('process metrics', {}, '2026-01-07T00:00:00Z');
    assert.deepEqual(result.cycle_time_days, { p50: 2, p90: 2, samples: 1 });
    assert.equal(result.throughput.completed, 1);
    assert.equal(result.status_wait_days.find(({ status }) => status === 'todo').total_days, 2);
    assert.equal(hashDb(), before);
  },
  'process-simulate': () => {
    add('one');
    add('two', { depends_on: ['one'] });
    const before = hashDb();
    const input = { scenarios: [{ name: 'baseline' }, { name: 'double', capacity_change: 1 }], runs: 1000 };
    const result = ok('process simulate', input);
    assert.equal(result.runs, 1000);
    assert.ok(result.scenarios[1].duration_days.p50 < result.scenarios[0].duration_days.p50);
    assert.ok(result.scenarios[0].finish.p90 > now);
    assert.equal(invoke('process simulate', input).stdout, invoke('process simulate', input).stdout);
    assert.equal(hashDb(), before);
  },
  'schedule-suggest': () => {
    add('one');
    add('two', { depends_on: ['one'] });
    const before = hashDb();
    const suggestion = ok('schedule suggest', { people, horizon_days: 7 });
    assert.deepEqual(suggestion.violations, []);
    assert.equal(suggestion.assignments.length, 2);
    const first = suggestion.assignments.find(({ task_id }) => task_id === 'one');
    const second = suggestion.assignments.find(({ task_id }) => task_id === 'two');
    assert.ok(first.end <= second.start);
    assert.deepEqual(ok('schedule check', { assignments: suggestion.assignments, people, horizon_days: 7 }).violations, []);
    const missing = invoke('schedule suggest', { list: 'default' });
    assert.equal(missing.status, 1);
    assert.equal(missing.answer.errors[0].code, 'E_INPUT_SCHEMA');
    for (const field of ['horizon_days', 'people', 'capacity_days_per_week', 'windows']) assert.ok(missing.answer.errors[0].message.includes(field), field);
    const empty = ok('schedule suggest', { horizon_days: 7 });
    assert.deepEqual(empty.assignments, []);
    assert.deepEqual(empty.violations.map(({ code, reason, task_id }) => [code, reason, task_id]), [['NO_FEASIBLE_SLOT', 'EMPTY_ROSTER', 'one'], ['DEPENDENCY_OPEN', undefined, 'two']]);
    for (const field of ['schedule suggest', 'people', 'windows', 'capacity_days_per_week']) assert.ok(empty.violations[0].hint.includes(field), field);
    assert.equal(hashDb(), before);
  },
  'schedule-check': () => {
    add('one');
    add('two', { depends_on: ['one'] });
    const before = hashDb();
    const result = ok('schedule check', { assignments: [
      { task_id: 'one', person_id: 'worker-1', start: now, end: '2026-01-02T00:00:00Z' },
      { task_id: 'two', person_id: 'worker-1', start: now, end: '2026-01-02T00:00:00Z' },
    ], people, horizon_days: 7 });
    assert.ok(result.violations.length >= 2);
    assert.equal(hashDb(), before);
  },
};
assert.ok(Object.hasOwn(checks, feature), `Unknown feature ${feature}`);
checks[feature]();
process.stdout.write(`pass  ${feature}\n`);

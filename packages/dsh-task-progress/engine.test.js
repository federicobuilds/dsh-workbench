import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTaskContent,
  estimateByAnalogy,
  conditionalExpectedSteps,
  emptyWorkspaceProfile,
  initSessionProjectionState,
  applySessionProjectionEvent,
  buildSessionForecast,
} from './engine.js';

test('parseTaskContent extracts explicit [S]/[M]/[L]/[XL] tags and falls back to heuristics', () => {
  const s = parseTaskContent('Read config file [S]');
  assert.equal(s.sizeTag, 'S');
  assert.equal(s.explicitTag, true);
  assert.equal(s.units, 1);
  assert.equal(s.cleanText, 'Read config file');

  const xl = parseTaskContent('Implement full multi-module database migration [XL]');
  assert.equal(xl.sizeTag, 'XL');
  assert.equal(xl.explicitTag, true);
  assert.equal(xl.units, 8);

  const untagged = parseTaskContent('Implement full architecture migration for auth');
  assert.equal(untagged.explicitTag, false);
  assert.equal(untagged.sizeTag, 'L');
  assert.ok(untagged.tokens.includes('architecture'));
  assert.ok(untagged.tokens.includes('migration'));
});

test('estimateByAnalogy matches k nearest tasks by token overlap and scales by size units', () => {
  const workspaceTasks = [
    { sizeTag: 'L', tokens: ['database', 'migration', 'users', 'schema'], steps: 8, activeMs: 80000 },
    { sizeTag: 'M', tokens: ['database', 'migration', 'orders'], steps: 4, activeMs: 40000 },
    { sizeTag: 'S', tokens: ['button', 'color', 'css'], steps: 1, activeMs: 8000 },
  ];
  const candidate = parseTaskContent('Write database migration for invoices schema [L]');
  const analogy = estimateByAnalogy(candidate, workspaceTasks, []);
  assert.ok(analogy !== null);
  assert.equal(analogy.matchCount, 2);
  assert.ok(analogy.plannedSteps >= 6 && analogy.plannedSteps <= 10);
});

test('conditionalExpectedSteps increases smoothly when consumed steps pass planned median (no 1s stuck bug)', () => {
  const atZero = conditionalExpectedSteps(0, 3, 'M', [2, 3, 3, 4, 6]);
  assert.equal(atZero, 3);

  const atThree = conditionalExpectedSteps(3, 3, 'M', [2, 3, 3, 4, 6]);
  assert.ok(atThree > 3, `Expected > 3 at s=3, got ${atThree}`);

  const atTen = conditionalExpectedSteps(10, 3, 'M', [2, 3, 3, 4, 6]);
  assert.ok(atTen >= 11, `Expected tail continuation > 10 at s=10, got ${atTen}`);
});

test('EVM fold attributes steps proportionally to parallel in-progress tasks and computes EV/BAC/CPI/SPI', () => {
  let state = initSessionProjectionState();
  const t0 = 1_700_000_000_000;

  state = applySessionProjectionEvent(state, {
    type: 'turn/start',
    seq: 1,
    time: t0,
    data: { turn: 1 },
  });

  state = applySessionProjectionEvent(state, {
    type: 'todo/write',
    seq: 2,
    time: t0 + 1000,
    data: {
      todos: [
        { content: 'Inspect schema [S]', status: 'completed' },
        { content: 'Build migration engine [L]', status: 'in_progress' },
        { content: 'Update docs [S]', status: 'in_progress' },
        { content: 'Run verification suite [M]', status: 'pending' },
      ],
    },
  });

  // Simulate 2 steps of 10s each while both [L] (4 units) and [S] (1 unit) are in_progress
  state = applySessionProjectionEvent(state, { type: 'step/start', seq: 3, time: t0 + 2000, data: { turn: 1, step: 1 } });
  state = applySessionProjectionEvent(state, { type: 'step/end', seq: 4, time: t0 + 12000, data: { turn: 1, step: 1 } });
  state = applySessionProjectionEvent(state, { type: 'step/start', seq: 5, time: t0 + 12000, data: { turn: 1, step: 2 } });
  state = applySessionProjectionEvent(state, { type: 'step/end', seq: 6, time: t0 + 22000, data: { turn: 1, step: 2 } });

  const largeTask = state.tasks.find(t => t.sizeTag === 'L');
  const smallTask = state.tasks.find(t => t.sizeTag === 'S' && t.status === 'in_progress');
  // 4:1 ratio -> 80% of 2 steps = 1.6 steps vs 0.4 steps
  assert.ok(Math.abs(largeTask.consumedSteps - 1.6) < 1e-6);
  assert.ok(Math.abs(smallTask.consumedSteps - 0.4) < 1e-6);

  const forecast = buildSessionForecast(state, {
    workspaceProfile: emptyWorkspaceProfile('/test'),
    machineTasks: [],
    kiloSignals: { active: true, editRevision: 2, recentBlocks: 0, recentReasons: [] },
    running: true,
    backgroundActive: false,
    waitingForUser: false,
    now: t0 + 25000,
  });

  assert.equal(forecast.hasTodos, true);
  assert.equal(forecast.completedCount, 1);
  assert.equal(forecast.totalCount, 4);
  assert.ok(forecast.percent > 12 && forecast.percent < 60, `Unexpected EV percent ${forecast.percent}`);
  assert.ok(forecast.liveRemainingMs > 5000);
  assert.equal(forecast.stoplight, 'green');
});

test('duplicate todo slots retain separate history across writes and size changes', () => {
  let state = initSessionProjectionState();
  const write = (time, todos) => { state = applySessionProjectionEvent(state, { type: 'todo/write', time, data: { todos } }); };
  write(1000, [{ content: 'Inspect config [S]', status: 'in_progress' }, { content: 'Inspect config [S]', status: 'pending' }]);
  state = applySessionProjectionEvent(state, { type: 'step/start', time: 2000 });
  state = applySessionProjectionEvent(state, { type: 'step/end', time: 5000 });
  write(6000, [{ content: 'Inspect config [L]', status: 'completed' }, { content: 'Inspect config [S]', status: 'in_progress' }]);
  state = applySessionProjectionEvent(state, { type: 'step/start', time: 7000 });
  state = applySessionProjectionEvent(state, { type: 'step/end', time: 11000 });
  write(12000, [{ content: 'Inspect config [L]', status: 'completed' }, { content: 'Inspect config [S]', status: 'in_progress' }]);
  assert.notEqual(state.tasks[0].key, state.tasks[1].key);
  assert.deepEqual(state.tasks.map(t => [t.startedAt, t.consumedSteps, t.consumedActiveMs]), [[1000, 1, 3000], [6000, 1, 4000]]);
});

test('legacy duplicate keys are assigned distinct slots without losing either history', () => {
  let state = initSessionProjectionState();
  const todos = [{ content: 'Inspect config [S]', status: 'in_progress' }, { content: 'Inspect config [S]', status: 'in_progress' }];
  state = applySessionProjectionEvent(state, { type: 'todo/write', time: 1000, data: { todos } });
  state.tasks = state.tasks.map((task, i) => ({ ...task, key: state.tasks[0].key, startedAt: 1000 + i, consumedSteps: i + 1 }));
  state = applySessionProjectionEvent(state, { type: 'todo/write', time: 2000, data: { todos } });
  assert.notEqual(state.tasks[0].key, state.tasks[1].key);
  assert.deepEqual(state.tasks.map(t => [t.startedAt, t.consumedSteps]), [[1000, 1], [1001, 2]]);
});

test('revision deltas use successive event timestamps for todo and goal revisions', () => {
  let state = initSessionProjectionState();
  state = applySessionProjectionEvent(state, { type: 'todo/write', time: 1000, data: { todos: [{ content: 'Task', status: 'pending' }] } });
  assert.equal(state.lastRevisionDeltaMs, 0);
  state = applySessionProjectionEvent(state, { type: 'goal/change', time: 4500, data: { kind: 'goal/change', operation: 'start', goal: {} } });
  assert.equal(state.lastRevisionDeltaMs, 3500);
  state = applySessionProjectionEvent(state, { type: 'user/message', time: 6000, data: { source: { kind: 'goal', round: 2 } } });
  assert.equal(state.lastRevisionDeltaMs, 1500);
});

test('an interrupted step records elapsed active time without a completed step sample', () => {
  let state = initSessionProjectionState();
  state = applySessionProjectionEvent(state, { type: 'turn/start', time: 1000 });
  state = applySessionProjectionEvent(state, { type: 'todo/write', time: 1100, data: { todos: [{ content: 'Task [S]', status: 'in_progress' }] } });
  state = applySessionProjectionEvent(state, { type: 'step/start', time: 2000 });
  state = applySessionProjectionEvent(state, { type: 'turn/end', time: 7000 });
  assert.equal(state.totalActiveMs, 5000);
  assert.equal(state.tasks[0].consumedActiveMs, 5000);
  assert.equal(state.tasks[0].consumedSteps, 0);
  assert.equal(state.totalSteps, 0);
  assert.deepEqual(state.stepDurationSamplesMs, []);
  state = applySessionProjectionEvent(state, { type: 'turn/end', time: 8000 });
  assert.equal(state.totalActiveMs, 5000);
});

test('non-finite stored calibration samples do not poison forecasts', () => {
  let state = initSessionProjectionState();
  state = applySessionProjectionEvent(state, { type: 'todo/write', time: 1000, data: { todos: [{ content: 'Inspect config [S]', status: 'in_progress' }] } });
  state = applySessionProjectionEvent(state, { type: 'step/start', time: 2000 });
  state = applySessionProjectionEvent(state, { type: 'step/end', time: 5000 });
  const workspaceProfile = emptyWorkspaceProfile('/test');
  workspaceProfile.stepDurationSamplesMs = [Infinity, NaN, 'bad', 4000];
  workspaceProfile.completedTasks = [{ sizeTag: 'S', tokens: ['inspect', 'config'], steps: Infinity, activeMs: Infinity }];
  const forecast = buildSessionForecast(state, { workspaceProfile, machineTasks: [], running: true, backgroundActive: false, waitingForUser: false, now: 6000 });
  assert.equal(forecast.calibratedStepMs, 8467);
  for (const name of ['calibratedStepMs', 'stepsPerUnit', 'bacSteps', 'liveRemainingMs']) assert.ok(Number.isFinite(forecast[name]), name);
  workspaceProfile.stepDurationSamplesMs = 'invalid';
  const invalidArrayForecast = buildSessionForecast(state, { workspaceProfile, machineTasks: [], running: true, backgroundActive: false, waitingForUser: false, now: 6000 });
  assert.ok(Number.isFinite(invalidArrayForecast.calibratedStepMs));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults, startRefresh } from './refresh.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const config = { ...defaults, autoUpdateOnTurnEnd: true, mcpDir: directory,
  pythonPath: process.execPath, sessionsRoot: directory, dbPath: join(directory, 'not-created.db') };
const current = { added: 1, updated: 2, removed: 0, unchanged: 3, failed: 0, failures: [], coverage: 'current' };

function report(child, stats = current) {
  child.stdout.emit('data', Buffer.from(JSON.stringify(stats)));
}

function setup(settings = config, launch) {
  let handler;
  let removals = 0;
  const calls = [];
  const ctx = { on(event, fn) {
    assert.equal(event, 'session/event');
    handler = fn;
    return () => { removals++; };
  } };
  const spawn = launch ?? ((...args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.signals = [];
    child.kill = signal => { child.signals.push(signal); return true; };
    calls.push({ args, child });
    return child;
  });
  const stop = startRefresh(ctx, settings, spawn);
  return { stop, calls, turn: () => handler?.({}, { type: 'turn/end' }),
    event: type => handler?.({}, { type }), removals: () => removals };
}

test('current coverage returns structured index stats', () => {
  const task = setup();
  task.turn();
  const stats = { ...current };
  report(task.calls[0].child, stats);
  task.calls[0].child.emit('close', 0, null);
  assert.equal(task.stop.status.state, 'ok');
  assert.deepEqual(task.stop.status.stats, stats);
  task.stop.status.stats.added = 99;
  assert.equal(task.stop.status.stats.added, 1);
  task.stop();
});

test('incomplete coverage and failed counts remain visible on zero and nonzero exits', () => {
  const task = setup();
  task.turn();
  report(task.calls[0].child, { ...current, coverage: 'incomplete' });
  task.calls[0].child.emit('close', 0, null);
  assert.equal(task.stop.status.reason, 'incomplete-coverage');
  assert.equal(task.stop.status.stats.coverage, 'incomplete');
  task.turn();
  const failed = { ...current, failed: 1, failures: [{ session: 'ses_123', reason: 'PermissionError' }] };
  report(task.calls[1].child, failed);
  task.calls[1].child.emit('close', 0, null);
  assert.equal(task.stop.status.reason, 'failed-index');
  assert.deepEqual(task.stop.status.stats.failures, failed.failures);
  task.turn();
  report(task.calls[2].child, failed);
  task.calls[2].child.emit('close', 1, null);
  assert.equal(task.stop.status.reason, 'nonzero-exit');
  assert.deepEqual(task.stop.status.stats.failures, failed.failures);
  task.stop();
});

test('malformed, empty, oversized and unknown status output never succeeds', () => {
  for (const output of ['', '{', 'x'.repeat(4097), JSON.stringify({ ...current, coverage: 'unknown' }),
    JSON.stringify({ ...current, extra: 'private' }), JSON.stringify({ ...current, failed: -1 }),
    JSON.stringify({ ...current, failed: 1, failures: [{ session: 'ses_1', reason: 'private message' }] })]) {
    const task = setup();
    task.turn();
    task.calls[0].child.stdout.emit('data', Buffer.from(output));
    task.calls[0].child.emit('close', 0, null);
    assert.equal(task.stop.status.state, 'failed');
    assert.equal(task.stop.status.reason, 'invalid-status');
    assert.equal(JSON.stringify(task.stop.status).includes('private'), false);
    task.stop();
  }
});

test('automatic refresh is off by default', () => {
  let registered = false;
  let launched = false;
  const stop = startRefresh({ on() { registered = true; } }, defaults, () => { launched = true; });
  assert.equal(defaults.autoUpdateOnTurnEnd, false);
  assert.equal(stop.status.state, 'disabled');
  assert.equal(registered, false);
  assert.equal(launched, false);
});

test('missing configuration is visible and never launches a child', () => {
  const task = setup({ ...config, mcpDir: '', pythonPath: '' });
  assert.deepEqual(task.stop.status, { state: 'configuration-error', field: 'mcpDir' });
  task.turn();
  assert.equal(task.calls.length, 0);
  task.stop();
  const badPython = setup({ ...config, pythonPath: join(directory, 'not-present') });
  assert.deepEqual(badPython.stop.status, { state: 'configuration-error', field: 'pythonPath' });
  badPython.turn();
  assert.equal(badPython.calls.length, 0);
  badPython.stop();
  const badDb = setup({ ...config, dbPath: directory });
  assert.deepEqual(badDb.stop.status, { state: 'configuration-error', field: 'dbPath' });
  badDb.stop();
  const badSessions = setup({ ...config, sessionsRoot: join(directory, 'not-present') });
  assert.deepEqual(badSessions.stop.status, { state: 'configuration-error', field: 'sessionsRoot' });
  badSessions.stop();
});

test('a synchronous spawn failure does not escape the turn event', () => {
  let attempts = 0;
  const task = setup(config, () => { attempts++; throw new Error('private text'); });
  assert.doesNotThrow(task.turn);
  assert.deepEqual(task.stop.status, { state: 'failed', reason: 'spawn-error' });
  assert.doesNotThrow(task.turn);
  assert.equal(attempts, 2);
  task.stop();
});

test('turn end coalesces one incremental refresh with structured arguments', () => {
  const task = setup();
  task.event('turn/start');
  assert.equal(task.calls.length, 0);
  task.turn();
  task.turn();
  task.turn();
  assert.equal(task.calls.length, 1);
  const [python, args, options] = task.calls[0].args;
  assert.equal(python, config.pythonPath);
  assert.equal(args[0], '-c');
  assert.match(args[1], /indexer\.update_index\(\)/);
  assert.doesNotMatch(args[1], /import (server|embed)/);
  assert.equal(options.cwd, config.mcpDir);
  assert.equal(options.env.DSH_CHAT_INDEX_DB, config.dbPath);
  assert.equal(options.env.DSH_SESSIONS_DIR, config.sessionsRoot);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  report(task.calls[0].child);
  task.calls[0].child.emit('close', 0, null);
  assert.equal(task.calls.length, 2);
  report(task.calls[1].child);
  task.calls[1].child.emit('close', 0, null);
  assert.equal(task.calls.length, 2);
  assert.equal(task.stop.status.state, 'ok');
  task.stop();
});

test('child errors, nonzero exit and bounded stderr have safe status', () => {
  const task = setup();
  task.turn();
  const first = task.calls[0].child;
  first.stderr.emit('data', Buffer.from('private contents'));
  first.emit('error', new Error('private error'));
  assert.equal(task.stop.status.reason, 'child-error');
  first.emit('close', null, null);
  assert.deepEqual(task.stop.status, { state: 'failed', reason: 'child-error', stderrBytes: 16, stderrTruncated: false, stderrKind: 'other' });
  task.turn();
  const second = task.calls[1].child;
  second.stderr.emit('data', Buffer.concat([Buffer.from('PermissionError: private text\n'), Buffer.alloc(5000)]));
  second.emit('close', 2, null);
  assert.deepEqual(task.stop.status, { state: 'failed', reason: 'nonzero-exit', stderrBytes: 4096, stderrTruncated: true, stderrKind: 'PermissionError' });
  task.stop();
});

test('a coalesced rerun retains the previous failure diagnostic', () => {
  const task = setup();
  task.turn();
  task.turn();
  task.calls[0].child.emit('close', 2, null);
  assert.equal(task.calls.length, 2);
  assert.equal(task.stop.status.state, 'running');
  assert.equal(task.stop.status.last.reason, 'nonzero-exit');
  task.stop.status.last.reason = 'changed';
  assert.equal(task.stop.status.last.reason, 'nonzero-exit');
  task.calls[1].child.emit('close', 0, null);
  task.stop();
});

test('dispose signals only the owned child and suppresses late reruns', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const task = setup();
  task.turn();
  task.turn();
  const owned = task.calls[0].child;
  const unrelated = { signals: [] };
  task.stop();
  task.stop();
  assert.equal(task.removals(), 1);
  assert.deepEqual(owned.signals, ['SIGTERM']);
  assert.deepEqual(unrelated.signals, []);
  owned.emit('error', new Error('late'));
  owned.emit('close', null, 'SIGTERM');
  owned.emit('error', new Error('later'));
  owned.emit('exit', 0, null);
  task.turn();
  t.mock.timers.tick(3000);
  assert.equal(task.calls.length, 1);
  assert.deepEqual(owned.signals, ['SIGTERM']);
  assert.equal(task.stop.status.state, 'disposed');
});

test('dispose escalates only the owned child if it does not close', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const task = setup();
  task.turn();
  const owned = task.calls[0].child;
  task.stop();
  t.mock.timers.tick(2000);
  assert.deepEqual(owned.signals, ['SIGTERM', 'SIGKILL']);
  owned.emit('close', null, 'SIGKILL');
  assert.equal(task.stop.status.state, 'disposed');
});

test('signal failures stay visible without throwing from disposal or timer', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const task = setup();
  task.turn();
  const owned = task.calls[0].child;
  owned.kill = () => { throw new Error('private failure'); };
  assert.doesNotThrow(task.stop);
  assert.equal(task.stop.status.reason, 'kill-error');
  assert.doesNotThrow(() => t.mock.timers.tick(2000));
  owned.emit('close', null, 'SIGKILL');
});

test('default index and sessions paths remain in the user home', () => {
  assert.equal(defaults.dbPath, join(homedir(), '.dsh/chat-index.db'));
  assert.equal(defaults.sessionsRoot, join(homedir(), '.dsh/sessions'));
});

test('a stalled refresh is terminated and a queued turn is retried', async () => {
  const task = setup({ ...config, timeoutMs: 10 });
  try {
    task.turn();
    task.turn();
    const child = task.calls[0].child;
    const keepAlive = setTimeout(() => {}, 1000);
    try { await new Promise(resolve => { child.kill = resolve; }); }
    finally { clearTimeout(keepAlive); }
    assert.equal(task.stop.status.reason, 'timeout');
    child.emit('close', null, 'SIGTERM');
    assert.equal(task.calls.length, 2);
    const next = task.calls[1].child;
    report(next);
    next.emit('close', 0, null);
    assert.equal(task.stop.status.state, 'ok');
  } finally {
    task.stop();
  }
});

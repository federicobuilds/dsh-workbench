import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { apply } from './index.js';
import { emptyWorkspaceProfile, parseTaskContent } from './engine.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

async function host(rows = new Map()) {
  let definition;
  let active = true;
  let disposeCalls = 0;
  let cleanup;
  let failures = 0;
  const reads = [];
  const calls = [];
  const agents = new Map();
  const jobs = new Map();
  const table = {
    get(key) { reads.push(key); return rows.get(key); },
    entries() { return rows.entries(); },
    async put(key, value) {
      if (failures > 0) { failures--; throw new Error('write failed'); }
      rows.set(key, structuredClone(value));
    },
  };
  const domains = {
    dsh_task_progress_calibration: { table: () => table },
    dsh_verification: { table: () => ({ get: id => ({ revision: id === 'session-a' ? 17 : 0 }) }) },
  };
  const ctx = {
    effect(fn) { cleanup = fn(); },
    get(key) {
      return {
        storageDomain: { get: name => domains[name] },
        jobs: { list(id) { calls.push(id); return jobs.get(id) ?? []; } },
        agents: { get: id => agents.get(id), list: () => [...agents.values()], isOwnedBy: (id, parent) => agents.get(id)?.parentId === parent.id },
      }[key];
    },
    sessionProjections: {
      async register(value) {
        definition = value;
        return {
          stateOf: session => session.state,
          async dispose() { if (active) { active = false; disposeCalls++; } },
        };
      },
    },
  };
  await apply(ctx);
  return {
    rows, reads, calls, agents, jobs,
    failWrites(count) { failures = count; },
    definition: () => definition,
    create(id, cwd = '/workspace') { return { id, header: { id, cwd }, state: definition.init({ id, cwd }, 0) }; },
    event(session, type, data) { session.state = definition.apply(session.state, { type, time: 1000, seq: 1, data }); },
    view(session) { return active ? definition.wire.view(session.state) : undefined; },
    cleanup: () => cleanup(),
    disposeCalls: () => disposeCalls,
  };
}

test('DL02 releases the projection on unload and repeated cleanup is safe', async () => {
  const nativeRegistry = new URL(import.meta.resolve('@deepseek-ai/dsh-session-projection'));
  const source = readFileSync(nativeRegistry, 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace(/^export \{.*\};?$/m, 'globalThis.Registry = SessionProjectionRegistry;');
  const sandbox = {
    Service: class { constructor(ctx) { this.ctx = ctx; } },
    SessionLogOffset: value => value,
    SessionSeq: value => value,
  };
  vm.runInNewContext(source, sandbox);
  const effects = new Map();
  const ctx = {
    fiber: { state: 1, assertActive() {} },
    logger: { warn() {}, error() {} },
    on: () => () => {},
    get: () => undefined,
    effect(fn, label) {
      const cleanup = fn();
      let active = true;
      const dispose = () => { if (active) { active = false; return Promise.resolve(cleanup()); } return Promise.resolve(); };
      effects.set(label, dispose);
      return dispose;
    },
  };
  ctx.sessionProjections = new sandbox.Registry(ctx);
  await apply(ctx);
  const session = { id: 'session-a', header: { id: 'session-a', cwd: '/workspace' }, seq: 0, inheritedEventCount: 0, snapshotEvents: () => [] };
  assert.ok(ctx.sessionProjections.snapshot(session).values.taskProgress);
  await effects.get('task-progress: lifecycle')();
  assert.equal(ctx.sessionProjections.snapshot(session).values.taskProgress, undefined);
  await effects.get('sessionProjections.register()')();
  await effects.get('task-progress: lifecycle')();
  assert.equal(ctx.sessionProjections.snapshot(session).values.taskProgress, undefined);
});

test('DL01 wire forecast retains session and workspace identity after folding', async () => {
  const h = await host();
  const session = h.create('session-a', '/real-workspace');
  h.event(session, 'todo/write', { todos: [{ content: 'Inspect [S]', status: 'pending' }] });
  const view = h.view(session);
  assert.equal(session.state.sessionId, 'session-a');
  assert.equal(session.state.workspace, '/real-workspace');
  assert.equal(view.guardEditRevision, 17);
  assert.ok(h.reads.includes('/real-workspace'));
  assert.ok(h.calls.includes('session-a'));
  assert.equal(h.definition().stateVersion, 5);
  assert.throws(() => h.definition().stateSchema.parse({ tasks: [] }));
  assert.equal(h.definition().stateSchema.parse(session.state), session.state);
  assert.equal(h.definition().wire.viewSchema.parse(view), view);
});

test('DL03 committed job events invalidate the wire forecast without a clock', async () => {
  const h = await host();
  const session = h.create('session-a');
  h.event(session, 'todo/write', { todos: [{ content: 'Inspect [S]', status: 'pending' }] });
  const previous = session.state;
  h.jobs.set(session.id, [{ owner: session.id, status: 'running' }]);
  h.event(session, 'job/registered', { jobId: 'job-1' });
  assert.notEqual(session.state, previous);
  assert.equal(h.view(session).executionState, 'background');
  const registered = session.state;
  h.jobs.set(session.id, []);
  h.event(session, 'job/settled', { jobId: 'job-1' });
  assert.notEqual(session.state, registered);
  assert.equal(h.view(session).executionState, 'waiting-user');
});

test('DL04 durable source acknowledgments survive reload and the rolling sample cap', async () => {
  const legacy = { id: `123-${parseTaskContent('same [S]').key}`, sizeTag: 'S', tokens: ['same'], steps: 1, activeMs: 1000 };
  const rows = new Map([['/workspace', { ...emptyWorkspaceProfile('/workspace'), completedTasks: [legacy] }]]);
  let h = await host(rows);
  const complete = async (id, content) => {
    const session = h.create(id);
    h.event(session, 'todo/write', { todos: [{ content, status: 'completed' }] });
    h.view(session);
    await flush();
    return session;
  };
  const first = await complete('session-a', 'same [S]');
  await complete('session-b', 'same [S]');
  assert.equal(rows.get('/workspace').completedTasks.length, 3);
  assert.deepEqual(rows.get('/workspace').completedTasks[0], legacy);
  for (const id of ['simultaneous-a', 'simultaneous-b']) {
    const session = h.create(id);
    h.event(session, 'todo/write', { todos: [{ content: 'concurrent [S]', status: 'completed' }] });
    h.view(session);
  }
  await flush();
  assert.equal(rows.get('/workspace').completedTasks.length, 5);
  for (let i = 0; i < 81; i++) await complete(`other-${i}`, `different ${i} [S]`);
  assert.equal(rows.get('/workspace').completedTasks.length, 80);
  await h.cleanup();
  h = await host(rows);
  h.view(first);
  await flush();
  assert.equal(rows.get('/workspace').completedTasks.length, 80);
  assert.equal(rows.get('/workspace').completedTasks.some(entry => entry.sourceSessionId === 'session-a'), false);
  const failSession = h.create('failure');
  h.event(failSession, 'todo/write', { todos: [{ content: 'retry [S]', status: 'completed' }] });
  h.failWrites(1);
  h.view(failSession);
  await flush();
  assert.equal(rows.get('/workspace').completedTaskSources.includes(JSON.stringify(['failure', parseTaskContent('retry [S]').key])), false);
  h.view(failSession);
  await flush();
  assert.equal(rows.get('/workspace').completedTasks.filter(entry => entry.sourceSessionId === 'failure').length, 1);
});

test('DL03 client observes native child agent status without a projection event', () => {
  let dock;
  const state = [];
  let cursor = 0;
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'fragment',
    useState(value) { const index = cursor++; state[index] ??= typeof value === 'function' ? value() : value; return [state[index], v => { state[index] = v; }]; },
    useRef(value) { const index = cursor++; state[index] ??= { current: value }; return state[index]; },
    useEffect() {},
  };
  let plugin;
  const window = { __ModuleLoader__: { load: spec => { plugin = spec.factory(() => react); } } };
  vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), { window, Date, setInterval, clearInterval });
  plugin.apply({ effect() {}, slots: { inject: (_slot, fn) => fn(), register: (_spec, component) => { dock = component; } } });
  const rows = {
    parent: { id: 'parent', running: false, retainedBy: {} },
    child: { id: 'child', parentId: 'parent', origin: 'subagent', running: false, retainedBy: {} },
  };
  const list = { getSnapshot: () => ({ byId: rows, ids: ['parent', 'child'], phase: 'ready' }), subscribe: () => () => {} };
  const forwarded = new Map();
  let root;
  let nativePlugin;
  const nativeWindow = { __ModuleLoader__: { load: spec => {
    nativePlugin = spec.factory(name => ({
      '@deepseek-ai/cordis': { Service: class { constructor(ctx) { this.ctx = ctx; } } },
      '@deepseek-ai/dsh-client-store': { notifySubscribers: listeners => { for (const listener of listeners) listener(); } },
      '@deepseek-ai/dsh-client-ui-slots': { standardHookPropName: name => `use${name}` },
      'react/jsx-runtime': {},
    })[name]);
  } } };
  const nativeClient = new URL('./client.js', import.meta.resolve('@deepseek-ai/dsh-client-ui-session'));
  vm.runInNewContext(readFileSync(nativeClient, 'utf8'), { window: nativeWindow, console, WeakRef, FinalizationRegistry });
  nativePlugin.apply({
    sessions: { list },
    remote: { $on: (event, listener) => { forwarded.set(event, listener); return () => forwarded.delete(event); } },
    effect: fn => fn(),
    slots: { provideRoot: value => { root = value; }, installScope() {} },
  });
  const projections = { todos: [{ status: 'pending' }], taskProgress: { hasTodos: true, completedCount: 0, totalCount: 1, executionState: 'waiting-user', backgroundJobsActive: false, liveRemainingMs: 10000 } };
  const props = {
    sessionId: 'parent',
    useProjection: key => projections[key],
    useSession: fn => fn({ running: false }),
    useSessions: fn => fn({ byId: rows }),
    useSessionStatus: fn => fn(root.hooks.sessionStatus.getSnapshot()),
    t: key => key,
  };
  const render = () => { cursor = 0; return JSON.stringify(dock(props)); };
  let rendered = render();
  const unsubscribe = root.hooks.sessionStatus.subscribe(() => { rendered = render(); });
  assert.match(rendered, /state.waiting/);
  forwarded.get('api-session/status')('child', true);
  assert.match(rendered, /state.background/);
  forwarded.get('api-session/status')('child', false);
  assert.match(rendered, /state.waiting/);
  unsubscribe();
});

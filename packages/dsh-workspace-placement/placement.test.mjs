import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createPlacementOperations, placementEventSchema, PLACEMENT_DOMAIN_SPEC } from './placement.mjs';
import { placementDescriptors } from './protocol.mjs';
import { apply } from './host.mjs';

function fixture() {
  const records = new Map();
  const headers = new Map([
    ['source', { id: 'source', cwd: '/source' }],
    ['successor', { id: 'successor', cwd: '/successor' }],
    ['worker', { id: 'worker', cwd: '/worker', origin: 'subagent', parentSession: 'source' }],
  ]);
  const state = { live: new Set(), agents: new Set(), active: new Set(), archived: [], calls: [], opens: 0 };
  const table = { entries: () => records.entries(), get: key => records.get(key), async put(key, value) { state.calls.push('put'); records.set(key, value); } };
  const domain = { table: name => { assert.equal(name, 'events'); return table; } };
  const forbidden = name => () => { state.calls.push(name); throw new Error(`native mutator ${name}`); };
  const dependencies = {
    storageDomain: { get: name => { assert.equal(name, 'dsh_session_placement'); return domain; }, async open() { state.opens++; return domain; } },
    persistence: { async stat(id) { const header = headers.get(id); return header ? { header: { ...header }, location: { path: '/native/path' }, revision: 'unchanged' } : undefined; }, open: forbidden('open') },
    registry: { get: id => id === 'target' ? { id, path: '/target', sessionIds: ['native'], attachSession: forbidden('attach'), detachSession: forbidden('detach') } : undefined, get archivedSessionIds() { return state.archived; }, archiveSession: forbidden('archive'), deleteSession: forbidden('delete') },
    sessions: { get: id => state.live.has(id) ? {} : undefined }, agents: { get: id => state.agents.has(id) ? {} : undefined, resume: forbidden('resume') },
    activity: async id => state.active.has(id) ? [{}] : [],
  };
  const ops = createPlacementOperations(dependencies);
  return { records, headers, state, table, domain, dependencies, ops };
}
const task = (overrides = {}) => ({ taskId: 'task-A', originalParentSessionId: 'source', successorSessionId: 'successor', workerSessionId: 'worker', ...overrides });
const signal = () => new AbortController().signal;

test('strict event schema rejects malformed records and unknown fields', () => {
  const event = { v: 1, eventId: randomUUID(), op: 'append', kind: 'workspace', sessionId: 'source', workspaceId: 'target', at: 1 };
  assert.deepEqual(placementEventSchema.parse(event), event);
  for (const bad of [null, [], { ...event, extra: 1 }, { ...event, eventId: 'x' }, { ...event, v: 2 }, { ...event, at: Infinity }, { ...event, sessionId: '  ' }, { ...event, op: 'detach' }, { ...event, eventId: { toString: () => event.eventId } }]) assert.throws(() => placementEventSchema.parse(bad));
  const relationship = { v: 1, eventId: randomUUID(), op: 'append', kind: 'task', ...task({ workerSessionId: null }), at: 2 };
  assert.deepEqual(placementEventSchema.parse(relationship), relationship);
  for (const bad of [{ ...relationship, successorSessionId: null }, { ...relationship, workerSessionId: '' }, { ...relationship, extra: true }]) assert.throws(() => placementEventSchema.parse(bad));
  assert.equal(PLACEMENT_DOMAIN_SPEC.name, 'dsh_session_placement');
  assert.equal(PLACEMENT_DOMAIN_SPEC.version, 1);
});

test('append, queue deduplication, detach history and native invariants', async () => {
  const f = fixture();
  const before = JSON.stringify([...f.headers]);
  const second = createPlacementOperations(f.dependencies);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? f.ops : second).moveSessionReference('source', 'target', signal())));
  assert.ok(results.every(value => value.ok));
  assert.equal(results.filter(value => !value.duplicate).length, 1);
  assert.equal(f.records.size, 1);
  const eventId = results[0].event.eventId;
  assert.equal((await f.ops.listReferences(signal())).references.length, 1);
  assert.equal((await f.ops.detachReference(eventId, signal())).ok, true);
  assert.equal(f.records.size, 2);
  assert.equal((await f.ops.listReferences(signal())).references.length, 0);
  assert.equal((await f.ops.detachReference(eventId, signal())).reason, 'missing');
  assert.equal((await f.ops.moveSessionReference('source', 'target', signal())).duplicate, false);
  assert.equal(f.records.size, 3);
  assert.equal(JSON.stringify([...f.headers]), before);
  assert.ok(f.state.calls.every(call => call === 'put'));
});

test('task references preserve origin, parent and incomplete workflow status', async () => {
  const f = fixture();
  assert.equal((await f.ops.appendTaskReference(task(), signal())).ok, true);
  assert.equal((await f.ops.appendTaskReference(task({ taskId: 'task-B', workerSessionId: null }), signal())).ok, true);
  const refs = (await f.ops.listReferences(signal())).references;
  assert.equal(refs[0].incomplete, false);
  assert.equal(refs[1].incomplete, true);
  assert.equal(refs[1].archiveBlock, true);
  f.headers.get('worker').parentSession = 'other';
  assert.equal((await f.ops.appendTaskReference(task({ taskId: 'bad' }), signal())).reason, 'invalid');
  assert.equal((await f.ops.listReferences(signal())).references[0].unavailable, true);
  f.headers.get('worker').parentSession = 'source';
  f.headers.get('worker').origin = 'user';
  assert.equal((await f.ops.appendTaskReference(task({ taskId: 'bad' }), signal())).reason, 'invalid');
  f.headers.delete('successor');
  const stale = (await f.ops.listReferences(signal())).references;
  assert.equal(stale.length, 2);
  assert.ok(stale.every(ref => ref.unavailable && ref.archiveBlock));
});

test('missing historical identifiers cannot mask unavailable state', async () => {
  const f = fixture();
  f.headers.set('__proto__', { id: '__proto__', cwd: '/original' });
  assert.equal((await f.ops.moveSessionReference('__proto__', 'target', signal())).ok, true);
  f.headers.delete('__proto__');
  const refs = (await f.ops.listReferences(signal())).references;
  assert.equal(refs.length, 1);
  assert.equal(refs[0].unavailable, true);
  assert.equal(f.records.size, 1);
});

test('invalid, missing, live, active, archived, unavailable and cancellation refuse writes', async () => {
  for (const reason of ['invalid', 'missing', 'live', 'agent', 'active', 'archived', 'unknown-activity', 'bad-header', 'cancelled']) {
    const f = fixture();
    const controller = new AbortController();
    let source = 'source', target = 'target';
    if (reason === 'invalid') source = '  ';
    if (reason === 'missing') target = 'absent';
    if (reason === 'live') f.state.live.add(source);
    if (reason === 'agent') f.state.agents.add(source);
    if (reason === 'active') f.state.active.add(source);
    if (reason === 'archived') f.state.archived.push(source);
    if (reason === 'unknown-activity') f.dependencies.activity = async () => undefined;
    if (reason === 'bad-header') f.headers.get(source).id = 'other';
    if (reason === 'cancelled') controller.abort();
    const actual = await createPlacementOperations(f.dependencies).moveSessionReference(source, target, controller.signal);
    assert.equal(actual.reason, ({ agent: 'live', 'unknown-activity': 'unavailable', 'bad-header': 'unavailable', cancelled: 'unavailable' })[reason] ?? reason, reason);
    assert.equal(f.records.size, 0, reason);
  }
  const f = fixture();
  assert.equal((await f.ops.appendTaskReference(task({ successorSessionId: null, workerSessionId: null }), signal())).reason, 'invalid');
  assert.equal((await f.ops.appendTaskReference({ ...task(), extra: true }, signal())).reason, 'invalid');
  assert.equal((await f.ops.detachReference('bad', signal())).reason, 'invalid');
  assert.equal((await f.ops.moveSessionReference('absent', 'target', signal())).reason, 'missing');
  f.dependencies.persistence.stat = async () => { throw Object.assign(new Error('not found'), { name: 'SessionPersistenceNotFoundError' }); };
  assert.equal((await createPlacementOperations(f.dependencies).moveSessionReference('source', 'target', signal())).reason, 'missing');
  f.dependencies.storageDomain.get = () => undefined;
  f.dependencies.storageDomain.open = async () => { throw Object.assign(new Error('offline'), { reason: 'active' }); };
  assert.equal((await createPlacementOperations(f.dependencies).listReferences(signal())).reason, 'unavailable');
});

test('rechecks activity and cancellation within serialized writes', async () => {
  const f = fixture();
  let calls = 0;
  f.dependencies.activity = async () => ++calls === 2 ? [{}] : [];
  const result = await createPlacementOperations(f.dependencies).moveSessionReference('source', 'target', signal());
  assert.equal(result.reason, 'active');
  assert.equal(f.records.size, 0);
  const controller = new AbortController();
  f.dependencies.activity = async () => { controller.abort(); return []; };
  assert.equal((await createPlacementOperations(f.dependencies).moveSessionReference('source', 'target', controller.signal)).reason, 'unavailable');
  assert.equal(f.records.size, 0);
  f.dependencies.activity = async () => [];
  let stats = 0;
  const stat = f.dependencies.persistence.stat;
  f.dependencies.persistence.stat = async (...args) => { const result = await stat(...args); if (++stats === 2) f.state.live.add('source'); return result; };
  assert.equal((await createPlacementOperations(f.dependencies).moveSessionReference('source', 'target', signal())).reason, 'live');
  assert.equal(f.records.size, 0);
});

test('opens only the named domain and rejects write failure', async () => {
  const f = fixture();
  f.dependencies.storageDomain.get = () => undefined;
  f.dependencies.storageDomain.open = async spec => { assert.equal(spec, PLACEMENT_DOMAIN_SPEC); f.state.opens++; return f.domain; };
  assert.equal((await createPlacementOperations(f.dependencies).moveSessionReference('source', 'target', signal())).ok, true);
  assert.equal(f.state.opens, 1);
  f.table.put = async () => { throw new Error('offline'); };
  assert.equal((await createPlacementOperations(f.dependencies).appendTaskReference(task(), signal())).reason, 'unavailable');
  assert.equal(f.records.size, 1);
});

test('corrupt events and storage errors are unavailable without discarding history', async () => {
  const f = fixture();
  f.records.set('not-a-uuid', { invalid: true });
  assert.equal((await f.ops.listReferences(signal())).reason, 'unavailable');
  assert.equal((await f.ops.moveSessionReference('source', 'target', signal())).reason, 'unavailable');
  assert.equal(f.records.size, 1);
  f.records.clear();
  const key = randomUUID();
  f.records.set(key, { v: 1, eventId: key, op: 'detach', targetEventId: randomUUID(), at: 1 });
  assert.equal((await f.ops.listReferences(signal())).reason, 'unavailable');
  assert.equal(f.records.size, 1);
});

test('host placement namespace guards every method before any lookup', async () => {
  const f = fixture();
  let lookups = 0;
  const get = f.dependencies.storageDomain.get;
  f.dependencies.storageDomain.get = name => { if (name !== 'session_projcache') lookups++; return name === 'session_projcache' ? undefined : get(name); };
  const services = { sessionPersistence: f.dependencies.persistence, workspaceRegistry: f.dependencies.registry, sessions: f.dependencies.sessions, agents: f.dependencies.agents, storageDomain: f.dependencies.storageDomain, typert: { register: () => () => {} } };
  const ctx = { get: name => services[name], provide(name, service) { services[name] = service; }, effect(fn) { fn(); }, waterfall: (_name, request) => f.dependencies.activity(request.sessionId) };
  apply(ctx);
  const service = services.chatPlacement;
  const calls = [() => service.moveSessionReference('source', 'target'), () => service.appendTaskReference(task()), () => service.detachReference(randomUUID()), () => service.listReferences()];
  for (const invocation of [undefined, { service: 'chatDelete', peer: { principal: { kind: 'owner' }, signal: signal() } }, { service: 'chatPlacement', peer: { principal: { kind: 'guest' }, signal: signal() } }, { service: 'chatPlacement', peer: { principal: { kind: 'owner' }, signal: AbortSignal.abort() } }]) {
    ctx.invocation = invocation;
    for (const call of calls) assert.equal((await call()).reason, 'unauthorized');
  }
  assert.equal(lookups, 0);
  ctx.invocation = { service: 'chatPlacement', peer: { principal: { kind: 'owner' }, signal: signal() } };
  assert.equal((await service.moveSessionReference('source', 'target')).ok, true);
  assert.equal(lookups, 1);
  assert.deepEqual(placementDescriptors.map(entry => entry.method), ['moveSessionReference', 'appendTaskReference', 'detachReference', 'listReferences']);
});

test('reference panel drops only its own source onto a named workspace and opens the original', async () => {
  const f = fixture();
  const components = {}, mounts = [], opened = [];
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useRef: value => ({ current: value }),
    useId: () => 'fixture',
    useEffect() {},
  };
  let factory;
  runInNewContext(await readFile(new URL('./client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: module => { factory = module.factory; } } }, AbortController, document: {},
  });
  const remote = Object.fromEntries(['moveSessionReference', 'appendTaskReference', 'detachReference', 'listReferences'].map(method => [
    method, async (...args) => ({ ok: true, value: await f.ops[method](...args) }),
  ]));
  const slots = { inject(_name, fn) { fn(); }, register(value, component) { components[value.id] = component; } };
  const workspaceList = { getSnapshot: () => ({ items: [
    { workspaceId: 'own', title: 'Source workspace', path: '/source', sessionIds: ['source'] },
    { workspaceId: 'target', title: 'Target workspace', path: '/target', sessionIds: ['native'] },
  ] }), subscribe() { return () => {}; } };
  let workspaceMenu;
  const ctx = { slots, effect(fn) { fn(); }, get: name => ({
    slots,
    workspaces: { list: workspaceList },
    sessions: { list: { getSnapshot: () => ({ byId: { source: { title: 'Original chat' } } }), subscribe() { return () => {}; } } },
    uiWorkspace: { openSession: id => opened.push(id) },
    contextMenus: { close() {}, register(item) { workspaceMenu = item; return () => {}; } },
    remote: { async $mount({ descriptors }) { mounts.push(descriptors); return () => {}; } },
    'remote.chatPlacement': remote,
  })[name] };
  await factory(() => React).apply(ctx);
  assert.equal(mounts.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(mounts[0].map(d => d.parameters.map(p => p.codec.jsonSchema)))), JSON.parse(JSON.stringify(placementDescriptors.map(d => d.parameters.map(p => p.codec.jsonSchema)))));
  components['chat-placement']({ sessionId: 'source', displayTitle: 'Original chat' }).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  const nodes = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : [];
  const render = () => nodes(components['chat-placement-dialog']());
  const source = render().find(node => node.props.draggable);
  const target = render().find(node => node.type === 'li');
  assert.ok(source.children.includes('Original chat'));
  assert.deepEqual(target.children, ['Target workspace · /target']);
  const values = new Map();
  const transfer = { setData: (key, value) => values.set(key, value), getData: key => values.get(key), get types() { return [...values.keys()]; } };
  let prevented = 0;
  const event = { dataTransfer: transfer, preventDefault() { prevented++; } };
  target.props.onDrop(event);
  assert.equal(prevented, 0);
  // Source and target handlers share the ref created during one React render.
  const rendered = render();
  rendered.find(node => node.props.draggable).props.onDragStart(event);
  rendered.find(node => node.type === 'li').props.onDragOver(event);
  assert.equal(transfer.dropEffect, 'link');
  rendered.find(node => node.type === 'li').props.onDrop(event);
  await new Promise(resolve => setImmediate(resolve));
  const refs = (await f.ops.listReferences(signal())).references;
  assert.equal(refs.length, 1);
  assert.equal(refs[0].workspaceId, 'target');
  assert.equal(refs[0].sessionId, 'source');
  render().find(node => node.type === 'button' && node.children.includes('Close')).props.onClick();

  assert.equal(workspaceMenu.target, 'workspace');
  workspaceMenu.resolve({ workspaceId: 'target' })[0].run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(render().find(node => node.type === 'select').props.value, 'target');
  assert.ok(render().some(node => node.type === 'p' && node.children.includes('Target workspace · /target')));
  render().find(node => node.type === 'button' && node.children.includes('Original chat')).props.onClick();
  assert.deepEqual(opened, ['source']);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, lstat, readdir, rm, unlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createDeleteOperations } from './delete.mjs';
import { descriptors } from './protocol.mjs';
import { apply } from './host.mjs';

const id = 'session-11111111-2222-3333-4444-555555555555';

async function fixture(t, overrides = {}) {
  const temporaryRoot = await realpath(tmpdir());
  const root = await mkdtemp(join(temporaryRoot, 'dsh-delete-test-'));
  t.after(async () => { assert.ok(root.startsWith(join(temporaryRoot, 'dsh-delete-test-'))); await rm(root, { recursive: true, force: true }); });
  const dir = join(root, id);
  const path = join(dir, 'session.v4.jsonl.zstd');
  await mkdir(dir);
  await writeFile(path, 'self-owned fixture transcript');
  await writeFile(join(dir, 'session.lock'), '');
  await writeFile(join(root, 'sibling.txt'), 'keep');
  const state = { live: false, held: false, revision: 'r1', version: 4, location: true, archived: false, pinned: true, cached: true, accounted: true, opens: 0, closes: 0 };
  let clock = 0;
  const workspace = { get sessionIds() { return state.accounted ? [id] : []; }, async detachSession() { state.accounted = false; } };
  const persistence = {
    async stat() {
      try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
      return { header: { id, version: state.version }, revision: state.revision, ...(state.location ? { location: { kind: 'jsonl', path } } : {}) };
    },
    async open() {
      state.opens++;
      if (state.held) throw Object.assign(new Error('writer held'), { name: 'SessionAlreadyOwnedError' });
      state.held = true;
      return { async close() { state.closes++; state.held = false; } };
    },
  };
  const registry = {
    get archivedSessionIds() { return state.archived ? [id] : []; },
    get pinnedSessionIds() { return state.pinned ? [id] : []; },
    async archiveSession() { state.archived = true; state.pinned = false; },
    async unarchiveSession() { state.archived = false; },
    async pinSession() { state.pinned = true; },
    list() { return [workspace]; },
  };
  const dependencies = {
    persistence, registry,
    sessions: { get() { return state.live ? {} : undefined; } }, agents: { get() { return undefined; } },
    activity: async () => [], cache: { async delete() { state.cached = false; } }, now: () => clock,
    ...overrides,
  };
  const ops = createDeleteOperations(dependencies);
  t.after(() => ops.dispose());
  return { root, dir, path, state, dependencies, ops, setTime: value => { clock = value; } };
}
async function prepared(f) {
  const result = await f.ops.prepare(id, 'owner-peer');
  assert.equal(result.ok, true, result.reason);
  return result.token;
}
async function remains(f) { assert.equal(await readFile(f.path, 'utf8'), 'self-owned fixture transcript'); }

test('deletes exactly the transcript, preserves lock inode/directory/siblings, cleans accounting and cache', async t => {
  const f = await fixture(t);
  const lock = await lstat(join(f.dir, 'session.lock'));
  const token = await prepared(f);
  const result = await f.ops.commit(id, token, 'owner-peer');
  assert.deepEqual(result, { deleted: true, reason: '', warnings: [] });
  await assert.rejects(() => lstat(f.path), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.dir), ['session.lock']);
  assert.equal((await lstat(join(f.dir, 'session.lock'))).ino, lock.ino);
  assert.equal(await readFile(join(f.root, 'sibling.txt'), 'utf8'), 'keep');
  assert.equal(f.state.archived, true);
  assert.equal(f.state.accounted, false);
  assert.equal(f.state.cached, false);
  assert.equal(f.state.closes, 1);
});

for (const reason of ['live', 'held', 'changed', 'missing-location', 'old-format', 'extra-generation', 'expired', 'wrong-peer', 'invalid-id']) {
  test(`refuses ${reason} without removing the log`, async t => {
    const f = await fixture(t);
    const token = await prepared(f);
    let peer = 'owner-peer';
    let target = id;
    if (reason === 'live') f.state.live = true;
    if (reason === 'held') f.state.held = true;
    if (reason === 'changed') f.state.revision = 'r2';
    if (reason === 'missing-location') f.state.location = false;
    if (reason === 'old-format') f.state.version = 3;
    if (reason === 'extra-generation') await writeFile(join(f.dir, 'session.v3.jsonl'), 'old transcript');
    if (reason === 'expired') f.setTime(120001);
    if (reason === 'wrong-peer') peer = 'other-peer';
    if (reason === 'invalid-id') target = '../../outside';
    const result = await f.ops.commit(target, token, peer);
    assert.equal(result.deleted, false);
    await remains(f);
    assert.equal(f.state.archived, false);
    assert.equal(f.state.accounted, true);
  });
}

test('no-location and migrations are refused before acquiring a writer', async t => {
  const f = await fixture(t);
  f.state.location = false;
  assert.equal((await f.ops.prepare(id, 'owner-peer')).ok, false);
  f.state.location = true;
  f.state.version = 3;
  assert.equal((await f.ops.prepare(id, 'owner-peer')).ok, false);
  assert.equal(f.state.opens, 0);
});

test('confirmation is single-use even after a storage refusal', async t => {
  const f = await fixture(t);
  const token = await prepared(f);
  f.state.held = true;
  assert.equal((await f.ops.commit(id, token, 'owner-peer')).deleted, false);
  f.state.held = false;
  assert.equal((await f.ops.commit(id, token, 'owner-peer')).reason, 'confirmation');
  await remains(f);
});

for (const [name, reason] of [['WorkspaceActiveSessionError', 'active'], ['WorkspaceUnknownSessionError', 'missing']]) {
  test(`maps ${name} to ${reason} without unlinking the transcript`, async t => {
    const native = await import('node:fs/promises');
    let activityError;
    let unlinkCalls = 0;
    const f = await fixture(t, {
      activity: async () => { if (activityError) throw activityError; return []; },
      io: { ...native, unlink: async path => { unlinkCalls++; await unlink(path); } },
    });
    activityError = Object.assign(new Error(name), { name });
    const preparation = await f.ops.prepare(id, 'owner-peer');
    assert.equal(preparation.ok, false);
    assert.equal(preparation.reason, reason);
    assert.equal(preparation.diagnostic, undefined);
    activityError = undefined;
    const token = await prepared(f);
    activityError = Object.assign(new Error(name), { name });
    const result = await f.ops.commit(id, token, 'owner-peer');
    assert.equal(result.deleted, false);
    assert.equal(result.reason, reason);
    assert.equal(result.diagnostic, undefined);
    assert.equal(unlinkCalls, 0);
    await remains(f);
  });
}

test('write refusal reports sanitized metadata exactly once without unlinking', async t => {
  const native = await import('node:fs/promises');
  const reports = [];
  let unlinkCalls = 0;
  const secret = 'private message /fixture/secret';
  const f = await fixture(t, {
    onRefusal: info => { reports.push(info); throw new Error('logger failure'); },
    io: { ...native, unlink: async path => { unlinkCalls++; await unlink(path); } },
  });
  f.dependencies.persistence.open = async () => { throw Object.assign(new Error(secret), { code: 'EACCES' }); };
  const token = await prepared(f);
  const result = await f.ops.commit(id, token, 'owner-peer');
  assert.deepEqual(result, { deleted: false, reason: 'storage', warnings: [], diagnostic: { stage: 'open-write', name: 'Error', code: 'EACCES' } });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(reports, [{ stage: 'open-write', name: 'Error', code: 'EACCES' }]);
  assert.equal(JSON.stringify(reports).includes(secret), false);
  f.dependencies.persistence.open = async () => { throw Object.assign(new Error(secret), { name: 'a!'.repeat(70), code: 'E/ACCES' }); };
  const secondToken = await prepared(f);
  assert.deepEqual((await f.ops.commit(id, secondToken, 'owner-peer')).diagnostic, { stage: 'open-write', name: 'a'.repeat(64), code: 'EACCES' });
  assert.deepEqual(reports[1], { stage: 'open-write', name: 'a'.repeat(64), code: 'EACCES' });
  assert.equal(reports.length, 2);
  assert.equal(unlinkCalls, 0);
  await remains(f);
});

test('storage diagnostics roundtrip and appear in the dialog without private messages', async t => {
  const secret = 'private message /fixture/secret';
  let failure = Object.assign(new Error(secret), { name: 'Bad!Name', code: 'E/ACCES' });
  const f = await fixture(t, { activity: async () => { if (failure) throw failure; return []; } });
  const preparation = await f.ops.prepare(id, 'owner-peer');
  assert.deepEqual(preparation.diagnostic, { stage: 'idle', name: 'BadName', code: 'EACCES' });
  assert.equal(JSON.stringify(preparation).includes(secret), false);
  failure = undefined;
  const token = await prepared(f);
  failure = Object.assign(new Error(secret), { name: 'Bad!Name', code: 'E/ACCES' });
  const commit = await f.ops.commit(id, token, 'owner-peer');
  assert.deepEqual(commit.diagnostic, preparation.diagnostic);
  assert.equal(JSON.stringify(commit).includes(secret), false);
  const hostResult = descriptors[0].result;
  for (const value of [preparation, commit]) assert.deepEqual(hostResult.create().parse(JSON.parse(JSON.stringify(value))), value);
  assert.throws(() => hostResult.create().parse({ reason: 'storage', diagnostic: { stage: 'idle', name: 'Error', code: '/private' } }));
  let factory;
  const React = { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useSyncExternalStore: (_subscribe, snapshot) => snapshot(), useRef: () => ({ current: null }), useId: () => 'test', useEffect() {} };
  runInNewContext(await readFile(new URL('./client-delete.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load: module => { factory = module.factory; } } }, AbortController, document: {} });
  const components = {};
  let clientResult;
  const locale = { register() {}, bind: () => key => ({ storage: 'Storage refused the deletion. Nothing was deleted.', active: 'This chat is still working or held by another process. Stop or close it first.' }[key] ?? key), subscribe() {}, getSnapshot() {} };
  let prepareResult = preparation;
  const remote = {
    async prepare() { return { ok: true, value: clientResult.create().parse(JSON.parse(JSON.stringify(prepareResult))) }; },
    async commit(sessionId, confirmationToken) {
      assert.equal(sessionId, id);
      assert.equal(confirmationToken, token, 'The native remote envelope must be unwrapped before forwarding the token');
      return { ok: true, value: clientResult.create().parse(JSON.parse(JSON.stringify(commit))) };
    },
  };
  const slots = { inject(_name, fn) { fn(); }, register(value, component) { components[value.name] = component; } };
  await factory(() => React).apply({ slots, effect() {}, get(name) { return { slots, locale, contextMenus: { close() {} }, remote: { $mount: async ({ descriptors: ds }) => { clientResult = ds[0].result; return () => {}; } }, 'remote.chatDelete': remote }[name]; } });
  assert.deepEqual(JSON.parse(JSON.stringify(clientResult.jsonSchema)), hostResult.jsonSchema);
  assert.throws(() => clientResult.create().parse({ reason: 'storage', diagnostic: { stage: 'idle', name: 'Error', code: '/private' } }));
  const action = components['sidebar.workspaces.session.row.action']({ sessionId: id, useSessions: fn => fn({ byId: {} }) });
  action.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  const tree = components['shell.overlay']();
  const text = node => typeof node === 'string' ? node : node && typeof node === 'object' ? node.children.map(text).join('') : '';
  assert.match(text(tree), /Storage refused the deletion\. Nothing was deleted\./);
  assert.match(text(tree), /idle \/ BadName \/ EACCES/);
  assert.ok(!text(tree).includes(secret));
  const nodes = node => node && typeof node === 'object' ? [node, ...node.children.flatMap(nodes)] : [];
  nodes(tree).find(node => node.type === 'button' && node.children.includes('close')).props.onClick();
  prepareResult = { ok: true, token, expiresAt: 120000, reason: '' };
  action.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  nodes(components['shell.overlay']()).find(node => node.type === 'button' && node.children.includes('delete')).props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  const commitTree = components['shell.overlay']();
  assert.match(text(commitTree), /Storage refused the deletion\. Nothing was deleted\./);
  assert.match(text(commitTree), /idle \/ BadName \/ EACCES/);
  nodes(commitTree).find(node => node.type === 'button' && node.children.includes('close')).props.onClick();
  prepareResult = { ok: false, token: '', expiresAt: 0, reason: 'active' };
  action.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(text(components['shell.overlay']()), /This chat is still working or held by another process/);
  await remains(f);
});

test('rechecks publication after writer acquisition and releases the writer', async t => {
  const f = await fixture(t);
  const originalOpen = f.dependencies.persistence.open;
  f.dependencies.persistence.open = async (...args) => { const handle = await originalOpen(...args); f.state.live = true; return handle; };
  const token = await prepared(f);
  assert.equal((await f.ops.commit(id, token, 'owner-peer')).reason, 'live');
  assert.equal(f.state.closes, 1);
  await remains(f);
});

test('failed unlink restores archive/pin and never claims success', async t => {
  const native = await import('node:fs/promises');
  const f = await fixture(t, { io: { ...native, unlink: async () => { throw new Error('fixture refusal'); } } });
  const token = await prepared(f);
  const result = await f.ops.commit(id, token, 'owner-peer');
  assert.equal(result.deleted, false);
  assert.equal(f.state.archived, false);
  assert.equal(f.state.pinned, true);
  assert.equal(f.state.closes, 1);
  await remains(f);
});

test('cleanup and close failures after commit retain deleted:true with warnings', async t => {
  const f = await fixture(t, { cache: { async delete() { throw new Error('cache fixture refusal'); } } });
  const original = f.dependencies.persistence.open;
  f.dependencies.persistence.open = async (...args) => { const handle = await original(...args); return { async close() { await handle.close(); throw new Error('close fixture refusal'); } }; };
  const token = await prepared(f);
  const result = await f.ops.commit(id, token, 'owner-peer');
  assert.equal(result.deleted, true);
  assert.deepEqual(result.warnings, ['cache', 'lock']);
});

test('cancellation after unlink does not abandon cleanup', async t => {
  const native = await import('node:fs/promises');
  const control = new AbortController();
  const f = await fixture(t, { io: { ...native, unlink: async path => { await unlink(path); control.abort(); } } });
  const token = await prepared(f);
  const result = await f.ops.commit(id, token, 'owner-peer', control.signal);
  assert.equal(result.deleted, true);
  assert.equal(f.state.cached, false);
  assert.equal(f.state.accounted, false);
  assert.equal(f.state.closes, 1);
});

test('wire contracts name every argument and expose no workspace move', () => {
  assert.deepEqual(descriptors.map(d => d.method), ['prepare', 'commit']);
  for (const descriptor of descriptors) for (const parameter of descriptor.parameters) assert.equal(parameter.wire, parameter.name);
});

test('Host declares a valid gateway binding, scopes owner peer, and rejects missing/non-owner invocation', async () => {
  const services = { sessionPersistence: {}, workspaceRegistry: {}, sessions: {}, agents: {}, storageDomain: { get() { return undefined; } }, typert: { register() { return () => {}; } } };
  const ctx = { get: name => services[name], provide(name, value) { services[name] = value; }, effect(fn) { fn(); } };
  apply(ctx);
  const service = services.chatDelete;
  assert.equal(service.typertRemote.service, service);
  assert.equal(service.typertRemote.serviceKey, 'chatDelete');
  assert.equal(service[Symbol.for('cordis.tracker')].property, 'ctx');
  assert.throws(() => service.prepare(id), /authenticated owner/);
  ctx.invocation = { service: 'chatDelete', peer: { principal: { kind: 'guest' }, signal: new AbortController().signal } };
  assert.throws(() => service.prepare(id), /authenticated owner/);
});

test('history safeguards attach to each scoped compaction engine and unload cleanly', async () => {
  const summarize = async () => ({ summary: [{ type: 'text', text: 'small summary' }] });
  const root = { summarize };
  const scoped = { summarize };
  const hooks = new Map(), disposers = [];
  const services = { sessionPersistence: {}, workspaceRegistry: {}, sessions: {}, agents: {}, storageDomain: { get() {} }, typert: { register() { return () => {}; } }, compaction: root };
  const ctx = { get: name => services[name], provide(name, value) { services[name] = value; }, on(name, fn) { hooks.set(name, fn); return () => hooks.delete(name); }, effect(fn) { disposers.push(fn()); } };
  apply(ctx);
  assert.notEqual(root.summarize, summarize);
  const session = { append() {}, snapshotEvents: () => [] };
  hooks.get('agent/created')({ agent: { session, ctx: { get: name => name === 'compaction' ? scoped : undefined } } });
  assert.notEqual(scoped.summarize, summarize);
  for (const dispose of disposers.reverse()) await dispose?.();
  assert.equal(root.summarize, summarize);
  assert.equal(scoped.summarize, summarize);
});

test('manifest ships delete-only Client and all required runtime files', async () => {
  const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url)));
  assert.equal(manifest.exports['./client'], './client-delete.js');
  for (const file of ['host.mjs', 'delete.mjs', 'protocol.mjs', 'client-delete.js']) assert.ok(manifest.files.includes(file));
  assert.ok(!manifest.files.includes('client.js'));
  assert.ok(!manifest.files.includes('remote.mjs'));
  const client = await readFile(new URL('./client-delete.js', import.meta.url), 'utf8');
  assert.ok(client.includes("role: props.menu ? 'menuitem'"));
  assert.ok(client.includes('element.showModal()'));
  assert.ok(client.includes("t(done ? 'partial' : 'recovery')"));
  assert.ok(client.includes('.dcd-dialog{pointer-events:auto;'));
  assert.ok(!client.includes('dragstart'));
  assert.ok(!client.includes('document.body.append'));
});

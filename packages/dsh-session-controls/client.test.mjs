import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { applyBindings } from '../dsh-governance/bindings.mjs';

test('role routing preserves the full preset list and worker resolution', async () => {
  const all = ['dsh-coder', 'dsh-worker-researcher', 'dsh-coordinator-off'].map(id => ({ id }));
  for (const asynchronous of [false, true]) {
    const presets = {
      all,
      list() { return asynchronous ? Promise.resolve(this.all) : this.all; },
      resolve: async id => all.find(preset => preset.id === id),
    };
    const services = { agents: {}, agentPresets: presets, llm: {} };
    applyBindings({ get: name => services[name], on() {} });
    const pickerList = presets.list;
    applyBindings({ get: name => services[name], on() {} });
    assert.equal(presets.list, pickerList);
    assert.deepEqual(await presets.listAll(), all);
    assert.deepEqual((await presets.list()).map(preset => preset.id), ['dsh-coder']);
    assert.equal((await presets.resolve('dsh-worker-researcher')).id, 'dsh-worker-researcher');
  }
});

test('client bundle mounts a strict session Remote and the declared native dock slot', async () => {
  let module, mounted, slot, styled = false, removed = false;
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8');
  const document = { createElement: () => ({ dataset: {}, remove() { removed = true; } }), head: { appendChild() { styled = true; } } };
  const disposers = [];
  const browser = { document, window: { __ModuleLoader__: { load: row => { module = row; } } } };
  vm.runInNewContext(source, browser);
  assert.equal(module.id, '@dsh-workbench/dsh-session-controls');
  const exported = module.factory(name => { assert.equal(name, 'react'); return { createElement() {} }; });
  let resolveMount;
  const mountReady = new Promise(resolve => { resolveMount = resolve; });
  const ctx = { get(name) { if (name === 'remote') return { $mount: c => { mounted = c; return mountReady; } }; },
    effect(fn) { disposers.push(fn()); }, slots: { inject(name, fn) { assert.equal(name, 'conversation.input.dock'); fn(); }, register(spec, component) { slot = { spec, component }; } } };
  const activating = exported.apply(ctx);
  assert.equal(styled, false, 'no styles before Remote readiness');
  assert.equal(slot, undefined, 'no panel before Remote readiness');
  resolveMount();
  await activating;
  assert.equal(mounted.descriptors[0].namespace, 'dshSessionControlsUi');
  assert.equal(mounted.descriptors[0].parameters[0].lookup, 'agent');
  assert.equal(mounted.descriptors[0].parameters[0].codec.mode, 'strict');
  assert.equal(mounted.descriptors.some(descriptor => descriptor.method === 'enhance'), false);
  assert.equal(slot.spec.name, 'conversation.input.dock');
  assert.equal(slot.spec.inject('s-1').sessionId, 's-1');
  assert.equal(typeof slot.component, 'function'); assert.equal(styled, true);
  for (const dispose of disposers) dispose();
  assert.equal(removed, true);
});

test('unindexed workspace leaves the session guard healthy and controls enabled', async () => {
  let module, slot, value, stateIndex, open = true;
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8');
  const document = { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } };
  vm.runInNewContext(source, { document, window: { __ModuleLoader__: { load: row => { module = row; } } } });
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [stateIndex++ === 0 ? open : stateIndex === 2 ? value : initial, () => {}],
    useRef: initial => ({ current: initial }), useCallback: fn => fn, useEffect() {},
  };
  const exported = module.factory(() => react);
  await exported.apply({ get: () => ({ $mount: async () => {} }), effect() {}, slots: { inject: (_name, fn) => fn(), register: (spec, component) => { slot = { spec, component }; } } });
  value = { preset: 'dsh-coder', workspaceIndex: { status: 'ok', state: 'ok', label: 'Index: not indexed', indexed: false, stale: true, dirty: false, fingerprintMismatch: false }, logReady: true, controls: { roleSwitch: true, trackSwitch: true }, counts: { total: 0, blocked: 0 } }; stateIndex = 0;
  const tree = slot.component({ sessionId: 's-1', load() {} });
  const text = JSON.stringify(tree);
  assert.ok(!text.includes('Index: Missing'));
  assert.ok(!text.includes('Index: Corrupt'));
  assert.ok(text.includes('Index: not indexed'));
  assert.ok(text.includes('Session Guard'));
  const nodes = [];
  const walk = node => { if (node && typeof node === 'object') { nodes.push(node); node.children?.flat(Infinity).forEach(walk); } };
  walk(tree);
  assert.equal(nodes.find(n => n.props?.className === 'kh-mark').props['data-error'], false);
  assert.equal(nodes.find(n => n.children?.includes('Index: not indexed')).props['data-corrupt'], undefined);
  assert.equal(nodes.find(n => n.props?.['aria-label'] === 'Select session role').props.disabled, false);
  assert.equal(nodes.find(n => n.props?.['aria-label'] === 'Select worker track').props.disabled, false);
  assert.ok(!text.includes('Recent Activity'));
  open = false; stateIndex = 0;
  const collapsed = slot.component({ sessionId: 's-1', load() {} });
  const collapsedBar = collapsed.children[0];
  assert.equal(collapsedBar.props['aria-expanded'], false);
  assert.deepEqual(collapsedBar.children.filter(Boolean).map(node => node.props.className), ['kh-mark', 'kh-pill', 'kh-pill']);
  assert.ok(!JSON.stringify(collapsed).includes('Index: not indexed'));
  open = true; value.decisions = [{ id: 'one', kind: 'check', decision: 'pass' }]; stateIndex = 0;
  assert.ok(JSON.stringify(slot.component({ sessionId: 's-1', load() {} })).includes('Recent Activity'));
  value.decisions = [];
  value.workspaceIndex = { status: 'error', reason: 'corrupt-index', action: 'rebuild' };
  value.counts.blocked = 2; stateIndex = 0; nodes.length = 0;
  const corrupt = slot.component({ sessionId: 's-1', load() {} });
  walk(corrupt);
  assert.equal(nodes.find(n => n.props?.className === 'kh-mark').props['data-error'], true);
  assert.ok(JSON.stringify(corrupt).includes('Index: Corrupt'));
  assert.ok(JSON.stringify(corrupt).includes('Blocked: 2'));
  value.workspaceIndex = { status: 'corrupt' }; stateIndex = 0; nodes.length = 0;
  const corruptState = slot.component({ sessionId: 's-1', load() {} });
  walk(corruptState);
  assert.equal(nodes.find(n => n.props?.className === 'kh-mark').props['data-error'], true);
  assert.equal(nodes.find(n => n.children?.includes('Index: Corrupt')).props['data-corrupt'], true);
  value.workspaceIndex = { status: 'error', reason: 'other-index-error' }; stateIndex = 0;
  assert.ok(JSON.stringify(slot.component({ sessionId: 's-1', load() {} })).includes('Index: Error'));
});

test('track and role controls stay pending until host confirms the selected revision', async () => {
  let module, slot, cursor = 0;
  const state = [true, { preset: 'role-a', track: 'simple', trackRevision: 1, controls: { roleSwitch: true, trackSwitch: true }, decisions: [], model: { provider: 'openrouter', model: 'a' }, availableRoles: [{ id: 'role-a', target: 'openrouter/a' }, { id: 'role-b', target: 'openrouter/b' }] }, null, false, 'all'];
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8');
  const document = { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } };
  vm.runInNewContext(source, { document, window: { __ModuleLoader__: { load: row => { module = row; } } } });
  const react = { createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], next => { state[i] = typeof next === 'function' ? next(state[i]) : next; }]; },
    useRef: initial => { const i = cursor++; if (!(i in state)) state[i] = { current: initial }; return state[i]; },
    useCallback: fn => fn, useEffect() {} };
  await module.factory(() => react).apply({ get: () => ({ $mount: async () => {} }), effect() {}, slots: { inject: (_name, fn) => fn(), register: (_spec, component) => { slot = component; } } });
  let settle;
  const save = new Promise(resolve => { settle = resolve; });
  const props = { sessionId: 's-1', load() {}, saveRole() {}, saveTrack: () => save };
  const render = () => { cursor = 0; return slot(props); };
  const find = (node, label) => {
    if (!node || typeof node !== 'object') return undefined;
    if (node.props?.['aria-label'] === label) return node;
    return node.children?.flat(Infinity).map(child => find(child, label)).find(Boolean);
  };
  const pending = find(render(), 'Select worker track').props.onChange({ target: { value: 'advanced' } });
  let tree = render();
  assert.equal(find(tree, 'Select worker track').props.value, 'simple');
  assert.equal(find(tree, 'Select worker track').props.disabled, true);
  assert.equal(find(tree, 'Select session role').props.disabled, true);
  settle({ ok: true, value: { ...state[1], sessionId: 's-1', track: 'advanced', trackRevision: 2 } });
  await pending;
  tree = render();
  assert.equal(find(tree, 'Select worker track').props.value, 'advanced');
  assert.equal(find(tree, 'Select session role').props.disabled, false);
  const rejected = find(tree, 'Select worker track').props.onChange({ target: { value: 'free' } });
  await rejected;
  tree = render();
  assert.equal(find(tree, 'Select worker track').props.value, 'advanced');
  assert.ok(JSON.stringify(tree).includes('Worker track could not be confirmed. Refresh to check, then retry if needed.'));
  let finishRole;
  props.saveRole = () => new Promise(resolve => { finishRole = resolve; });
  const role = find(render(), 'Select session role').props.onChange({ target: { value: 'role-b' } });
  tree = render();
  assert.equal(find(tree, 'Select worker track').props.disabled, true);
  assert.equal(find(tree, 'Select session role').props.value, 'role-a');
  finishRole({ ok: true, value: { ...state[1], sessionId: 's-1', preset: 'role-b' } });
  await role;
  tree = render();
  assert.equal(find(tree, 'Select session role').props.value, 'role-a');
  assert.ok(JSON.stringify(tree).includes('Role and model could not be confirmed. Refresh to check, then retry if needed.'));
  props.saveRole = async () => ({ ok: true, value: { ...state[1], sessionId: 's-1', preset: 'role-b', model: { provider: 'openrouter', model: 'b' } } });
  await find(render(), 'Select session role').props.onChange({ target: { value: 'role-b' } });
  assert.equal(find(render(), 'Select session role').props.value, 'role-b');
});

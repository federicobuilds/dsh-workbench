import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRouter } from './runner.mjs';
import { createRecommendationService } from './recommendation.mjs';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('routing uses catalog summaries without reading every skill body', async () => {
  let hook;
  const registry = {
    snapshot: async () => ({ skills: [{ name: 'session', description: 'Recall prior work', invocation: { modelInvocable: true } }] }),
    get: async () => assert.fail('The router must not load unselected skill bodies'),
  };
  const judge = { decide: async value => { assert.equal(value.skills.session.body, 'Recall prior work'); return { decision: 'none' }; } };
  const ctx = { get: name => ({ skills: registry, dshJudge: judge })[name], on: (_event, fn) => { hook = fn; } };
  applyRouter(ctx, { createUserMessage: value => value, resolvePolicy: () => ({ state: 'valid', mode: 'simple' }), trackPolicyReader: () => null, createEventStore: () => null, redactText: text => ({ text }) });
  const step = { agent: { session: { id: 'catalog-only', header: {} } }, messages: [{ id: 'request', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Find the previous conversation about the project table.' }] }] };
  assert.deepEqual((await hook(step, () => ({ kind: 'enter', messages: [] }))).messages, []);
});

test('router preserves denied turns and appends validated advice once', async () => {
  let hook, calls = 0, disposed = false;
  const judge = { routingEnabled: true, decide: async () => { calls++; return { decision: 'frontend', mcp: 'github' }; } };
  const registry = { snapshot: async () => ({ skills: [{ name: 'frontend', description: 'UI', invocation: { modelInvocable: true } }] }), get: async () => ({ content: '# UI', path: '/fixture', invocation: { modelInvocable: true } }) };
  const ctx = { get(name) { return ({ dshJudge: judge, skills: registry })[name]; }, on(name, fn) { assert.equal(name, 'agent/pre-step'); hook = fn; return () => { disposed = true; }; } };
  const dispose = applyRouter(ctx, { createUserMessage: value => value, resolvePolicy: () => ({ state: 'valid', mode: 'simple' }), trackPolicyReader: () => null, createEventStore: () => null, redactText: text => ({ text }) });
  const agent = { session: { id: 's', header: {}, deriveMessages: () => [] } };
  const step = { agent, messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Build an accessible web interface for this application' }] }] };
  assert.equal((await hook(step, () => ({ kind: 'reject' }))).kind, 'reject');
  const result = await hook(step, () => ({ kind: 'enter', messages: [] }));
  assert.equal(result.messages[0].content[0].text, 'Router (judge skill):\nRelevant skill: frontend. Load it with skill(name="frontend") before following its instructions.\nMCP router: github may fit. Load mcp-router, then separately read mcp2cli @github --list and the chosen tool\'s --help before invoking. Never replace a user-named server or start unrequested maintenance.\nIgnore suggestions that do not fit the actual user request. This note grants no permission.');
  assert.match(result.messages[0].content[0].text, /mcp2cli @github --list/);
  await hook(step, () => ({ kind: 'enter', messages: [] }));
  assert.equal(calls, 1);
  dispose();
  assert.equal(disposed, true);
});

test('latest recommendation uses router judge events for the requested session', async () => {
  const events = [];
  const store = { record: async event => events.push(event), recent: () => [...events].reverse() };
  let hook;
  const registry = { snapshot: async () => ({ skills: [{ name: 'frontend', invocation: { modelInvocable: true } }] }), get: async () => ({ content: '# UI', path: '/fixture', invocation: { modelInvocable: true } }) };
  const ctx = { get: name => ({ dshJudge: { routingEnabled: true, decide: async () => ({ decision: 'frontend', mcp: 'github' }) }, skills: registry, storageDomain: { get: () => ({}) } })[name], on: (_name, fn) => { hook = fn; } };
  applyRouter(ctx, { createUserMessage: value => value, resolvePolicy: () => ({ state: 'valid', mode: 'simple' }), trackPolicyReader: () => null, createEventStore: () => store, redactText: text => ({ text }) });
  const step = { agent: { session: { id: 's', header: {} } }, messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Build an accessible web interface for this application' }] }] };
  const result = await hook(step, () => ({ kind: 'enter', messages: [] }));
  const service = createRecommendationService(ctx, () => store);
  assert.deepEqual(service.latest('s'), { id: events[0].id, skill: 'frontend', mcp: 'github' });
  assert.match(result.messages[0].content[0].text, /Relevant skill: frontend/);
  assert.equal(service.latest('other'), null);
  step.messages.push({ id: 'short', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] });
  await hook(step, () => ({ kind: 'enter', messages: [] }));
  assert.equal(service.latest('s'), null);
});

test('standalone router calls judge when bundled routing is disabled', async () => {
  const events = [];
  const store = { record: async event => events.push(event), recent: () => [...events].reverse() };
  let hook, calls = 0;
  const registry = { snapshot: async () => ({ skills: [{ name: 'frontend', invocation: { modelInvocable: true } }] }), get: async () => ({ content: '# UI', path: '/fixture', invocation: { modelInvocable: true } }) };
  const judge = { routingEnabled: false, decide: async () => { calls++; return { decision: 'frontend', mcp: 'github' }; } };
  const ctx = { get: name => ({ dshJudge: judge, skills: registry, storageDomain: { get: () => ({}) } })[name], on: (_name, fn) => { hook = fn; } };
  applyRouter(ctx, { createUserMessage: value => value, resolvePolicy: () => ({ state: 'valid', mode: 'simple' }), trackPolicyReader: () => null, createEventStore: () => store, redactText: text => ({ text }) });
  const step = { agent: { session: { id: 's', header: {} } }, messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Build an accessible web interface for this application' }] }] };
  const result = await hook(step, () => ({ kind: 'enter', messages: [] }));
  assert.equal(calls, 1);
  assert.match(result.messages[0].content[0].text, /Relevant skill: frontend/);
  assert.deepEqual(createRecommendationService(ctx, () => store).latest('s'), { id: events[0].id, skill: 'frontend', mcp: 'github' });
});

test('off and unresolved policies use simple and keep other families', async () => {
  const cases = [
    [{ state: 'valid', mode: 'simple' }, 'simple'],
    [{ state: 'valid', mode: 'off' }, 'simple'],
    [{ state: 'missing' }, 'simple'],
    [{ state: 'valid', mode: 'free' }, 'free'],
    [{ state: 'valid', mode: 'advanced' }, 'advanced'],
  ];
  const notes = [], recorded = [];
  for (const [policy, expectedFamily] of cases) {
    let hook, family;
    const events = [];
    const registry = { snapshot: async () => ({ skills: [{ name: 'frontend', invocation: { modelInvocable: true } }] }), get: async () => ({ content: '# UI', path: '/fixture', invocation: { modelInvocable: true } }) };
    const judge = { decide: async input => { family = input.family; return { decision: 'frontend', mcp: 'github' }; } };
    const ctx = { get: name => ({ dshJudge: judge, skills: registry, storageDomain: { get: () => ({}) } })[name], on: (_name, fn) => { hook = fn; } };
    applyRouter(ctx, { createUserMessage: value => value, resolvePolicy: () => policy, trackPolicyReader: () => null, createEventStore: () => ({ record: async event => events.push(event) }), redactText: text => ({ text }) });
    const step = { agent: { session: { id: 's', header: {} } }, messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Build an accessible web interface for this application' }] }] };
    const result = await hook(step, () => ({ kind: 'enter', messages: [] }));
    assert.equal(family, expectedFamily);
    recorded.push(events.map(event => event.decision));
    notes.push(result.messages[0].content[0].text);
  }
  assert.equal(notes[1], notes[0]);
  assert.equal(notes[2], notes[0]);
  assert.deepEqual(recorded, cases.map(() => ['recommendation']));
});

test('router records no placeholder before a pending judge decision', async () => {
  let hook, eventsAtDecision;
  const events = [];
  const registry = { snapshot: async () => ({ skills: [{ name: 'frontend', invocation: { modelInvocable: true } }] }), get: async () => ({ content: '# UI', path: '/fixture', invocation: { modelInvocable: true } }) };
  const judge = { decide: async () => { eventsAtDecision = [...events]; return { decision: 'frontend' }; } };
  const ctx = { get: name => ({ dshJudge: judge, skills: registry, storageDomain: { get: () => ({}) } })[name], on: (_name, fn) => { hook = fn; } };
  applyRouter(ctx, { createUserMessage: value => value, resolvePolicy: () => ({ state: 'valid', mode: 'simple' }), trackPolicyReader: () => null, createEventStore: () => ({ record: async event => events.push(event) }), redactText: text => ({ text }) });
  const step = { agent: { session: { id: 's', header: {} } }, messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Build an accessible web interface for this application' }] }] };
  await hook(step, () => ({ kind: 'enter', messages: [] }));
  assert.deepEqual(eventsAtDecision, []);
  assert.deepEqual(events.map(event => event.decision), ['recommendation']);
});

test('explicit skill names and aliases recommend the longest non-negated match without the judge', async () => {
  let hook, calls = 0;
  const events = [];
  const registry = { snapshot: async () => ({ skills: ['router', 'mcp-router'].map(name => ({ name, invocation: { modelInvocable: true } })) }), get: async () => ({ content: '# Skill', invocation: { modelInvocable: true } }) };
  const judge = { decide: async () => { calls++; return { decision: 'none' }; } };
  const ctx = { get: name => ({ dshJudge: judge, skills: registry, storageDomain: { get: () => ({}) } })[name], on: (_name, fn) => { hook = fn; } };
  applyRouter(ctx, { createUserMessage: value => value, resolvePolicy: () => ({ state: 'valid', mode: 'off' }), trackPolicyReader: () => null, createEventStore: () => ({ record: async event => events.push(event) }), redactText: text => ({ text }) });
  const step = { agent: { session: { id: 's', header: {} } }, messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'what mcp router skills are available?' }] }] };
  const result = await hook(step, () => ({ kind: 'enter', messages: [] }));
  assert.equal(calls, 0);
  assert.match(result.messages[0].content[0].text, /Relevant skill: mcp-router/);
  assert.equal(result.messages[0].source.form, 'notice');
  assert.equal(result.messages[0].source.summary, 'Skill: mcp-router');
  assert.deepEqual(events.map(event => [event.decision, event.skill]), [['recommendation', 'mcp-router']]);
});

test('negated explicit skills fall back to the judge', async () => {
  for (const phrase of ['do not use', "don't recommend", 'avoid', 'skip', 'without']) {
    let hook, calls = 0;
    const registry = { snapshot: async () => ({ skills: [{ name: 'mcp-router', invocation: { modelInvocable: true } }] }), get: async () => ({ content: '# Skill', invocation: { modelInvocable: true } }) };
    const judge = { decide: async () => { calls++; return { decision: 'none' }; } };
    const ctx = { get: name => ({ dshJudge: judge, skills: registry })[name], on: (_name, fn) => { hook = fn; } };
    applyRouter(ctx, { createUserMessage: value => value, resolvePolicy: () => ({ state: 'valid', mode: 'off' }), trackPolicyReader: () => null, createEventStore: () => null, redactText: text => ({ text }) });
    const step = { agent: { session: { id: 's', header: {} } }, messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `Please ${phrase} mcp-router for this request` }] }] };
    const result = await hook(step, () => ({ kind: 'enter', messages: [] }));
    assert.equal(calls, 1, phrase);
    assert.deepEqual(result.messages, []);
  }
});

test('router records truthful no-recommendation and unavailable outcomes', async () => {
  for (const [outcome, expected] of [[{ decision: 'none' }, 'no-recommendation'], [{ unavailable: true }, 'unavailable'], ['throw', 'unavailable']]) {
    let hook;
    const events = [];
    const judge = { decide: async () => { if (outcome === 'throw') throw new Error('unavailable'); return outcome; } };
    const ctx = { get: name => ({ dshJudge: judge, storageDomain: { get: () => ({}) } })[name], on: (_name, fn) => { hook = fn; } };
    applyRouter(ctx, { createUserMessage: value => value, resolvePolicy: () => ({ state: 'valid', mode: 'off' }), trackPolicyReader: () => null, createEventStore: () => ({ record: async event => events.push(event) }), redactText: text => ({ text }) });
    const step = { agent: { session: { id: 's', header: {} } }, messages: [{ id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Build an accessible web interface for this application' }] }] };
    const result = await hook(step, () => ({ kind: 'enter', messages: [] }));
    assert.deepEqual(events.map(event => event.decision), [expected]);
    assert.deepEqual(result.messages, []);
  }
});

test('dock renders independent adjacent pills left of Index with accessible animated dismissal', async () => {
  let definition, component, plugin, style, injected;
  const values = [], effects = [], timers = [];
  let cursor = 0;
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), useState: initial => { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; }, useRef: initial => { const i = cursor++; return values[i] ??= { current: initial }; }, useEffect: fn => effects.push(fn) };
  const window = { __ModuleLoader__: { load: module => { plugin = module.factory(() => React); } } };
  const document = { createElement: () => (style = { dataset: {}, remove() {} }), head: { appendChild() {} } };
  runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), { window, document, AbortController, setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cleared = true; } });
  const ctx = { get: () => ({ $mount: async () => {} }), effect() {}, slots: { inject: (key, fn) => { injected = key; return fn(); }, register: (options, view) => { definition = options; component = view; } } };
  await plugin.apply(ctx);
  assert.equal(injected, 'conversation.input.dock');
  assert.equal(definition.name, 'conversation.input.dock');
  assert.equal(definition.order, 3);
  assert.match(style.textContent, /\.sr-dock\{position:relative;display:inline-flex;gap:6px\}/);
  assert.doesNotMatch(style.textContent, /\.sr-dock\{[^}]*margin-left:auto/);
  const anchor = '[data-slot="conversation.input.dock"]:has(> .sr-dock)';
  const width = 'width:calc(100% - var(--dsh-composer-side-clearance)*2);max-width:var(--dsh-composer-card-max-width)';
  assert.ok(style.textContent.includes(`${anchor}{box-sizing:border-box;${width};margin:0 auto 4px;display:grid!important;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;column-gap:6px}`));
  assert.ok(style.textContent.includes(`${anchor}>.kh-dock,${anchor}>.tp-dock{width:100%;max-width:none}`));
  assert.ok(style.textContent.includes(`${anchor}>:not(.sr-dock):not(.wi-dock){grid-column:1/-1}`));
  assert.ok(style.textContent.includes(`${anchor}>.sr-dock{grid-column:2}`));
  assert.ok(style.textContent.includes(`${anchor}>.wi-dock{grid-column:3;width:auto;max-width:none;margin:0;justify-content:flex-start}`));
  assert.ok(style.textContent.includes(`${anchor}>.wi-dock .wi-pill{white-space:nowrap;flex:none}`));
  assert.doesNotMatch(style.textContent, /body:has\(/);
  assert.match(style.textContent, /\.sr-card\{position:relative;display:inline-flex/);
  assert.doesNotMatch(style.textContent, /\.sr-card\{[^}]*position:absolute/);
  assert.doesNotMatch(style.textContent, /\.sr-card\{[^}]*right:0/);
  assert.match(style.textContent, /@keyframes sr-enter/);
  assert.match(style.textContent, /@keyframes sr-exit/);
  assert.match(style.textContent, /prefers-reduced-motion:reduce/);
  assert.match(style.textContent, /--dsw-alias-label-primary/);
  assert.match(style.textContent, /--dsw-alias-label-secondary/);
  let response = { ok: true, value: { id: 'e', skill: 'frontend', mcp: 'github' } }, fail = false;
  const props = { sessionId: 's', load: async () => { if (fail) throw new Error('transient'); return response; } };
  const render = () => { cursor = 0; effects.length = 0; return component(props); };
  const refresh = async () => { effects[0](); await new Promise(resolve => setImmediate(resolve)); };
  render();
  await refresh();
  assert.equal(timers[0].ms, 1000);
  let dock = render();
  assert.equal(dock.props['aria-live'], 'polite');
  assert.equal(dock.props['aria-atomic'], 'true');
  assert.equal(dock.children.length, 2);
  assert.deepEqual(dock.children.map(pill => pill.children[0].children[0]), ['Skill: frontend', 'MCP: github']);
  assert.deepEqual(dock.children.map(pill => pill.props.key), ['e:skill', 'e:mcp']);
  assert.deepEqual(dock.children.map(pill => pill.props['aria-label']), ['Skill recommendation', 'MCP recommendation']);
  assert.deepEqual(dock.children.map(pill => pill.props.className), ['sr-card sr-enter', 'sr-card sr-enter']);
  for (const pill of dock.children) {
    assert.equal(pill.children[1].children[0], 'Dismiss');
    assert.match(pill.children[1].props['aria-label'], /^Dismiss (skill|mcp) recommendation$/);
  }
  effects[1]();
  fail = true;
  render();
  await refresh();
  assert.equal(render().children.length, 2);
  fail = false;

  dock.children[0].children[1].props.onClick();
  dock = render();
  assert.equal(dock.children[0].props.className, 'sr-card sr-exit');
  assert.equal(dock.children[1].children[0].children[0], 'MCP: github');
  assert.equal(dock.children[1].props.className, 'sr-card sr-enter');
  effects[1]();
  assert.equal(timers.at(-1).ms, 180);
  timers.at(-1).fn();
  dock = render();
  assert.equal(dock.children.length, 1);
  assert.equal(dock.children[0].props.key, 'e:mcp');

  response = { ok: true, value: { id: 'new', skill: 'frontend', mcp: 'github' } };
  render();
  await refresh();
  dock = render();
  assert.deepEqual(dock.children.map(pill => pill.props.key), ['new:skill', 'new:mcp']);
  assert.deepEqual(dock.children.map(pill => pill.props.className), ['sr-card sr-enter', 'sr-card sr-enter']);
  effects[1]();
  dock.children[1].children[1].props.onClick();
  dock = render();
  assert.equal(dock.children[0].children[0].children[0], 'Skill: frontend');
  assert.equal(dock.children[0].props.className, 'sr-card sr-enter');
  assert.equal(dock.children[1].props.className, 'sr-card sr-exit');
  effects[1]();
  timers.at(-1).fn();
  dock = render();
  assert.equal(dock.children.length, 1);
  assert.equal(dock.children[0].props.key, 'new:skill');
  dock.children[0].children[1].props.onClick();
  dock = render();
  assert.equal(dock.children[0].props.className, 'sr-card sr-exit');
  effects[1]();
  timers.at(-1).fn();
  assert.equal(render().children.length, 0);

  response = { ok: true, value: { id: 'fade', skill: 'frontend', mcp: 'github' } };
  render();
  await refresh();
  dock = render();
  assert.deepEqual(dock.children.map(pill => pill.props.key), ['fade:skill', 'fade:mcp']);
  effects[1]();
  response = { ok: false };
  render();
  await refresh();
  dock = render();
  assert.deepEqual(dock.children.map(pill => pill.props.className), ['sr-card sr-exit', 'sr-card sr-exit']);
  const cancelExit = effects[1]();
  const exitTimers = timers.slice(-2);
  assert.deepEqual(exitTimers.map(timer => timer.ms), [180, 180]);
  response = { ok: true, value: { id: 'interrupt', skill: 'frontend', mcp: 'github' } };
  render();
  await refresh();
  dock = render();
  assert.deepEqual(dock.children.map(pill => pill.props.key), ['interrupt:skill', 'interrupt:mcp']);
  assert.deepEqual(dock.children.map(pill => pill.props.className), ['sr-card sr-enter', 'sr-card sr-enter']);
  cancelExit();
  assert.equal(exitTimers.every(timer => timer.cleared), true);
  effects[1]();

  response = { ok: true, value: { id: 'single', skill: 'frontend', mcp: null } };
  render();
  await refresh();
  dock = render();
  effects[1]();
  timers.at(-1).fn();
  dock = render();
  assert.equal(dock.children.length, 1);
  assert.equal(dock.children[0].children[0].children[0], 'Skill: frontend');

  response = { ok: true, value: { id: 'other-session', skill: 'frontend', mcp: 'github' } };
  const sessionProps = { ...props, sessionId: 'other' };
  cursor = 0;
  effects.length = 0;
  component(sessionProps);
  await refresh();
  cursor = 0;
  effects.length = 0;
  dock = component(sessionProps);
  assert.deepEqual(dock.children.map(pill => pill.props.key), ['other-session:skill', 'other-session:mcp']);
});
